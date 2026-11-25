// Engine A: yt-dlp. Searches the enabled sources, matches the right recording and streams its audio on stdout.
import { spawn, execFile } from "node:child_process";
import type { Candidate, MusicConfig, TrackQuery } from "../../../shared/music-protocol";
import { MATCH_THRESHOLD, isOpenLicense, scoreCandidate } from "../../../shared/music-match";
import { EngineError, type AudioSource, type Engine } from "./types";
import { lookups } from "../lookup-cache";

const PREFIX = { youtube: "ytsearch", soundcloud: "scsearch" } as const;
const SEARCH_RESULTS = 8;

export const ytdlpBinary = (cfg?: MusicConfig) => cfg?.ytdlp.binary || process.env.YTDLP_PATH || "yt-dlp";

interface FlatEntry { id?: string; title?: string; url?: string; webpage_url?: string; duration?: number; channel?: string; uploader?: string; ie_key?: string; live_status?: string; thumbnails?: { url: string }[]; license?: string }

function run(bin: string, args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new EngineError(err.message.includes("ENOENT") ? "yt-dlp is not installed on the worker" : (String(stderr).trim().split("\n").pop() || err.message), err.message.includes("ENOENT") ? "unavailable" : "failed"));
      else resolve(stdout);
    });
  });
}

export async function ytdlpVersion(cfg?: MusicConfig): Promise<string | null> {
  try { return (await run(ytdlpBinary(cfg), ["--version"], 8000)).trim(); } catch { return null; }
}

/** One yt-dlp search, cached for 12 hours (an hour when it found nothing) so repeats don't hit YouTube/SoundCloud again. */
function flatSearch(provider: "youtube" | "soundcloud", terms: string, cfg: MusicConfig, n: number): Promise<Candidate[]> {
  return lookups.wrap(`ytdlp|${provider}|${n}|${terms.trim().toLowerCase()}`, 12 * 3600_000, () => flatSearchLive(provider, terms, cfg, n), { ttlFor: (v) => (v.length ? 12 * 3600_000 : 3600_000) });
}

async function flatSearchLive(provider: "youtube" | "soundcloud", terms: string, cfg: MusicConfig, n: number): Promise<Candidate[]> {
  const out = await run(ytdlpBinary(cfg), ["--flat-playlist", "--dump-single-json", "--no-warnings", "--skip-download", `${PREFIX[provider]}${n}:${terms}`]);
  const entries = ((JSON.parse(out) as { entries?: FlatEntry[] }).entries ?? []).filter((e) => e && (e.url || e.webpage_url));
  return entries.map((e) => ({
    engine: "ytdlp" as const,
    sourceId: `${provider}:${e.id ?? e.url}`,
    title: e.title ?? "Unknown",
    artist: (e.channel || e.uploader || "").trim(),
    durationSec: e.duration ?? 0,
    url: (e.webpage_url || e.url) as string,
    score: 0,
    license: e.license,
    artworkUrl: e.thumbnails?.[e.thumbnails.length - 1]?.url,
    sourceName: provider,
    live: e.live_status === "is_live",
  })) as Candidate[];
}

interface FullInfo { license?: string; is_live?: boolean; duration?: number; availability?: string; artist?: string; track?: string; uploader?: string; title?: string }

/** Full extraction of one item: the only way to learn its licence and whether it is a live stream. */
async function inspect(c: Candidate, cfg: MusicConfig): Promise<FullInfo> {
  return JSON.parse(await run(ytdlpBinary(cfg), ["--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", c.url])) as FullInfo;
}

async function verify(c: Candidate, cfg: MusicConfig): Promise<Candidate> {
  const info = await inspect(c, cfg).catch((e: unknown) => { throw new EngineError(`Could not inspect ${c.sourceId}: ${(e as Error).message}`, "failed"); });
  if (info.is_live) throw new EngineError("Live streams are not supported", "failed");
  const license = info.license ?? c.license;
  if (cfg.licensePolicy === "licensed-only" && !isOpenLicense(license)) {
    throw new EngineError(`"${c.title}" is not under an open licence (${license || "licence unknown"}). Switch the licence policy to "attested" only if you have the rights.`, "unlicensed");
  }
  return { ...c, license, durationSec: info.duration ?? c.durationSec };
}

export const ytdlpEngine: Engine = {
  id: "ytdlp",

  async search(text, cfg, limit) {
    const providers = cfg.ytdlp.providers.length ? cfg.ytdlp.providers : (["soundcloud"] as const);
    const settled = await Promise.allSettled(providers.map((p) => flatSearch(p, text, cfg, Math.min(limit, 15))));
    const ok = settled.flatMap((s, i) => (s.status === "fulfilled" ? s.value.map((c, j) => ({ ...c, score: 1 - j * 0.02 - i * 0.01 })) : []));
    if (!ok.length && settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    return ok.sort((a, b) => b.score - a.score).slice(0, limit);
  },

  async resolve(query: TrackQuery, cfg) {
    const terms = `${query.artist} ${query.title}`.trim();
    const providers = cfg.ytdlp.providers.length ? cfg.ytdlp.providers : (["soundcloud"] as const);
    const settled = await Promise.allSettled(providers.map((p) => flatSearch(p, terms, cfg, SEARCH_RESULTS)));
    const flat = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (!flat.length) {
      const err = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      throw err ? err.reason : new EngineError(`No source returned any result for "${query.title}" by ${query.artist}`, "not-found");
    }
    const ranked = flat
      .map((c) => ({ ...c, score: scoreCandidate(query, { title: c.title, artist: c.artist, durationSec: c.durationSec, isLive: (c as unknown as { live?: boolean }).live }).score }))
      .filter((c) => c.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) throw new EngineError(`No recording of "${query.title}" by ${query.artist} matched closely enough`, "not-found");
    const accepted: Candidate[] = [];
    let lastErr: EngineError | undefined;
    for (const c of ranked.slice(0, 5)) {
      try { accepted.push(await verify(c, cfg)); } catch (e) { lastErr = e as EngineError; }
      if (accepted.length >= 2) break;
    }
    if (!accepted.length) throw lastErr ?? new EngineError("No usable result", "not-found");
    return accepted;
  },

  async open(c, cfg): Promise<AudioSource> {
    if (!/^https?:\/\//i.test(c.url)) throw new EngineError("Unsupported URL", "failed");
    const v = await verify(c, cfg); // policy gate, also for pinned (user-picked) results
    const proc = spawn(ytdlpBinary(cfg), ["-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "--no-progress", "--socket-timeout", "20", "--retries", "3", "-o", "-", v.url], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-600); });
    const done = new Promise<void>((resolve, reject) => {
      proc.once("error", (e) => reject(new EngineError((e as NodeJS.ErrnoException).code === "ENOENT" ? "yt-dlp is not installed on the worker" : e.message, "unavailable")));
      proc.once("close", (code, sig) => (code === 0 ? resolve() : reject(new EngineError(`yt-dlp ${sig ?? `exited ${code}`}: ${err.trim().split("\n").pop() ?? ""}`))));
    });
    done.catch(() => {});
    return { stream: proc.stdout, realtime: false, done, close: () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } } };
  },
};
