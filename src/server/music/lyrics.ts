import "server-only";
// Lyrics through Lavalink's LavaLyrics plugin. LavaLyrics needs a Lavalink track, so the song is first searched on the node
// (YouTube Music gives the cleanest title/artist), then GET /v4/lyrics returns lines from LRCLIB, YouTube Music, ...
// Works for every song (library, yt-dlp or Lavalink): the search is only used to get a track to ask about, nothing plays.
import { MATCH_THRESHOLD, baseTitle, normalize, scoreCandidate } from "@shared/music-match";
import { searchPrefixes } from "@shared/lavalink-search";
import type { Lyrics, LyricsResult } from "@/lib/music-types";
import { getSettings, type Settings } from "../settings";
import { cached, forgetMemory } from "../cache";

type Node = Settings["musicLavalinkNodes"][number];
interface LlTrack { encoded: string; info: { title: string; author: string; length: number; isStream: boolean; sourceName: string } }
interface RawLyrics { sourceName?: string; provider?: string; text?: string | null; lines?: { timestamp?: number; duration?: number | null; line?: string }[] }

// Lyrics don't change: found ones are kept for a month, "none found" for a day (all in the database, see ../cache).
const HIT_TTL = 30 * 86400_000;
const MISS_TTL = 86400_000;
const SEARCH_TTL = 7 * 86400_000;
const g = globalThis as unknown as { __riftLyricsNoPlugin?: Map<string, number> };
const noPlugin = (g.__riftLyricsNoPlugin ??= new Map()); // node id -> when we learnt it has no LavaLyrics
export const clearLyricsCache = () => { forgetMemory("lyrics:"); forgetMemory("llsearch:"); noPlugin.clear(); };

class NoPlugin extends Error {}
/** Thrown inside the cached lookup when no node could answer, so that answer isn't stored. */
class Unanswered extends Error { constructor(public result: LyricsResult) { super(result.reason ?? "unanswered"); } }

async function rest<T>(n: Node, path: string): Promise<{ status: number; body: T | null }> {
  const r = await fetch(n.url.replace(/\/$/, "") + path, { headers: { Authorization: n.password }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 204) return { status: 204, body: null };
  if (!r.ok) return { status: r.status, body: null };
  return { status: r.status, body: (await r.json().catch(() => null)) as T | null };
}

export function mapLyrics(raw: RawLyrics): Lyrics | null {
  const lines = (raw.lines ?? [])
    .filter((l) => typeof l.line === "string")
    .map((l) => ({ t: Math.max(0, Number(l.timestamp) || 0), d: l.duration == null ? null : Number(l.duration) || null, text: l.line!.trim() }));
  const synced = lines.length > 1 && lines.some((l) => l.t > 0);
  const text = raw.text?.trim() || (lines.length ? lines.map((l) => l.text).join("\n") : "");
  if (!text && !lines.some((l) => l.text)) return null;
  return { provider: raw.provider || null, source: raw.sourceName || null, synced, lines: synced ? lines.sort((a, b) => a.t - b.t) : [], text: text || null };
}

/** The best search result on a node for this song, per prefix (YouTube Music, YouTube, then the node's own prefixes). */
async function candidates(n: Node, q: { title: string; artist: string; durationSec?: number }, allowed: string[]): Promise<LlTrack[]> {
  const prefixes = [...new Set(["ytmsearch", "ytsearch", ...searchPrefixes(n.searchPrefix, allowed)])].slice(0, 4);
  const text = `${q.artist} ${baseTitle(q.title)}`.trim();
  const out: LlTrack[] = [];
  for (const p of prefixes) {
    // Searches are cached too (some nodes rate-limit hard); only the search, not the lyrics call, needs the node's tracks.
    const r = await cached(`llsearch:${n.url}|${p}:${text}`, SEARCH_TTL, async () => {
      const x = await rest<{ loadType: string; data: unknown }>(n, `/v4/loadtracks?identifier=${encodeURIComponent(`${p}:${text}`)}`);
      if (x.status === 429 || x.status >= 500) throw new Error(`node answered ${x.status}`);
      return x;
    }, { keep: (x) => !!x.body }).catch(() => null);
    if (!r?.body) continue;
    const list = r.body.loadType === "search" ? (r.body.data as LlTrack[]) : r.body.loadType === "track" ? [r.body.data as LlTrack] : [];
    const best = list
      .filter((t) => t?.encoded && !t.info.isStream)
      .map((t) => ({ t, s: scoreCandidate({ title: q.title, artist: q.artist, durationSec: q.durationSec, allowVariants: true }, { title: t.info.title, artist: t.info.author, durationSec: t.info.length / 1000 }).score }))
      .filter((x) => x.s >= MATCH_THRESHOLD)
      .sort((a, b) => b.s - a.s)[0];
    if (best) out.push(best.t);
    if (out.length >= 2) break;
  }
  return out;
}

async function fromNode(n: Node, q: { title: string; artist: string; durationSec?: number }, allowed: string[]): Promise<Lyrics | null> {
  for (const t of await candidates(n, q, allowed)) {
    const r = await rest<RawLyrics>(n, `/v4/lyrics?track=${encodeURIComponent(t.encoded)}&skipTrackSource=false`);
    if (r.status === 404) throw new NoPlugin();
    const l = r.body ? mapLyrics(r.body) : null;
    if (l) return l;
  }
  return null;
}

export async function findLyrics(q: { title: string; artist: string; durationSec?: number }): Promise<LyricsResult> {
  const s = await getSettings();
  if (!s.musicLyrics) return { lyrics: null, reason: "Lyrics are turned off (Admin → Music → Settings)." };
  if (!s.musicLavalinkNodes.length) return { lyrics: null, reason: "Lyrics come from a Lavalink node with the LavaLyrics plugin, and none is configured." };
  const key = `lyrics:${normalize(q.artist)}|${normalize(baseTitle(q.title)) || q.title.toLowerCase()}`;
  try {
    return await cached(key, HIT_TTL, async () => {
      let sawPlugin = false;
      let failed: string | null = null;
      for (const n of s.musicLavalinkNodes) {
        const since = noPlugin.get(n.id);
        if (since && Date.now() - since < 10 * 60_000) continue;
        try {
          const l = await fromNode(n, q, s.musicLavalinkAllowedSources);
          sawPlugin = true;
          if (l) return { lyrics: l } as LyricsResult;
        } catch (e) {
          if (e instanceof NoPlugin) noPlugin.set(n.id, Date.now());
          else failed = `${n.name}: ${(e as Error).message}`;
        }
      }
      if (sawPlugin) return { lyrics: null, reason: "No lyrics found for this song." } as LyricsResult;
      // Only real answers are kept, not "node unreachable".
      throw new Unanswered({ lyrics: null, reason: failed ? `Couldn't reach the Lavalink node (${failed}).` : "No Lavalink node has the LavaLyrics plugin. Turn on “Lyrics plugins” for the bundled node (Admin → Music → Settings), write the config and restart lavalink." });
    }, { ttlFor: (v) => (v.lyrics ? HIT_TTL : MISS_TTL), staleMs: 0 });
  } catch (e) {
    if (e instanceof Unanswered) return e.result;
    throw e;
  }
}
