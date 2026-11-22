import "server-only";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { db } from "../db";
import { env } from "../config";
import { getSettings } from "../settings";
import { normalize } from "@shared/music-match";

/** MP3, FLAC, AAC, OGG, WAV and Opus (plus the common containers/aliases of the same codecs). */
export const MUSIC_EXTENSIONS = new Set([".mp3", ".flac", ".aac", ".m4a", ".ogg", ".oga", ".opus", ".wav", ".aif", ".aiff", ".wma"]);
export const isMusicFile = (f: string) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()) && !path.basename(f).startsWith(".");
export const coverDir = () => path.join(env.dataDir, "music", "covers");

const sh = (cmd: string, args: string[], opts: { encoding?: "buffer"; timeout?: number; maxBuffer?: number } = {}) =>
  new Promise<Buffer>((resolve, reject) =>
    execFile(cmd, args, { encoding: "buffer", timeout: opts.timeout ?? 30_000, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(`${cmd}: ${err.toString().trim().split("\n").pop() || e.message}`)) : resolve(out))),
  );
const ffprobe = () => process.env.FFPROBE_PATH || "ffprobe";
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";

export interface ProbedAudio {
  container: string;
  codec: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  durationSec: number;
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  discNo?: number;
  hasEmbeddedCover: boolean;
}

const firstInt = (v: unknown) => { const n = parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n > 0 ? n : undefined; };

export async function probeAudio(file: string): Promise<ProbedAudio> {
  const raw = JSON.parse((await sh(ffprobe(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file])).toString());
  const streams: Record<string, unknown>[] = raw.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!audio) throw new Error("No audio stream");
  const cover = streams.some((s) => s.codec_type === "video" && (s.disposition as { attached_pic?: number } | undefined)?.attached_pic === 1);
  // Tags live on the format for most containers, on the stream for Ogg/Opus: merge, format wins.
  const tags: Record<string, string> = {};
  for (const src of [(audio.tags ?? {}) as Record<string, string>, (raw.format?.tags ?? {}) as Record<string, string>]) for (const [k, v] of Object.entries(src)) tags[k.toLowerCase()] = String(v);
  const t = (...k: string[]) => k.map((x) => tags[x]).find((v) => v && v.trim())?.trim();
  const genre = t("genre")?.split(/[;/\0]/)[0]?.trim();
  return {
    container: String(raw.format?.format_name ?? "").split(",")[0],
    codec: String(audio.codec_name ?? ""),
    bitrate: firstInt(raw.format?.bit_rate ?? audio.bit_rate),
    sampleRate: firstInt(audio.sample_rate),
    channels: firstInt(audio.channels),
    durationSec: Number(raw.format?.duration ?? audio.duration) || 0,
    title: t("title"),
    artist: t("artist", "album_artist", "albumartist"),
    albumArtist: t("album_artist", "albumartist"),
    album: t("album"),
    genre: genre && !/^\(?\d+\)?$/.test(genre) ? genre : undefined,
    year: firstInt(t("date", "year", "originaldate", "originalyear")?.slice(0, 4)),
    trackNo: firstInt(t("track", "tracknumber")),
    discNo: firstInt(t("disc", "discnumber")),
    hasEmbeddedCover: cover,
  };
}

/** Stores the embedded (or folder) cover as a small JPEG and returns its hash, or null. */
export async function extractCover(file: string, embedded: boolean): Promise<string | null> {
  let img: Buffer | null = null;
  if (embedded) img = await sh(ffmpeg(), ["-v", "error", "-i", file, "-an", "-map", "0:v:0", "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "3", "-f", "mjpeg", "pipe:1"]).catch(() => null);
  if (!img?.length) {
    const dir = path.dirname(file);
    for (const n of ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "front.png", "album.jpg", "albumart.jpg"]) {
      const p = path.join(dir, n);
      if (await access(p).then(() => true, () => false)) {
        img = await sh(ffmpeg(), ["-v", "error", "-i", p, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "3", "-f", "mjpeg", "pipe:1"]).catch(() => null);
        if (img?.length) break;
      }
    }
  }
  if (!img?.length) return null;
  const hash = createHash("sha1").update(img).digest("hex");
  await mkdir(coverDir(), { recursive: true });
  await writeFile(path.join(coverDir(), `${hash}.jpg`), img);
  return hash;
}

export const albumKeyOf = (albumArtist: string, album: string) => createHash("sha1").update(`${normalize(albumArtist)}|${normalize(album)}`).digest("hex").slice(0, 16);

export async function indexFile(file: string, source: "upload" | "import"): Promise<{ id: string; created: boolean }> {
  const st = await stat(file);
  const existing = await db.musicTrack.findUnique({ where: { path: file } });
  if (existing && existing.status === "ready" && Number(existing.size) === st.size && Number(existing.mtimeMs) === Math.floor(st.mtimeMs)) return { id: existing.id, created: false };
  const p = await probeAudio(file);
  const base = path.basename(file, path.extname(file)).replace(/^\d+[\s._-]+/, "").replace(/_/g, " ");
  const title = p.title || base;
  const artist = p.artist || "Unknown artist";
  const albumArtist = p.albumArtist || undefined;
  const albumKey = p.album ? albumKeyOf(albumArtist ?? artist, p.album) : `s${createHash("sha1").update(file).digest("hex").slice(0, 15)}`;
  const coverHash = await extractCover(file, p.hasEmbeddedCover);
  const data = {
    size: BigInt(st.size), mtimeMs: BigInt(Math.floor(st.mtimeMs)), container: p.container, codec: p.codec, bitrate: p.bitrate, sampleRate: p.sampleRate, channels: p.channels,
    durationSec: p.durationSec, title, artist, albumArtist: albumArtist ?? null, album: p.album ?? null, albumKey, genre: p.genre ?? null, year: p.year ?? null,
    trackNo: p.trackNo ?? null, discNo: p.discNo ?? null, coverHash, status: "ready", source,
  };
  if (existing) { await db.musicTrack.update({ where: { id: existing.id }, data }); return { id: existing.id, created: false }; }
  const row = await db.musicTrack.create({ data: { path: file, ...data } });
  if (!coverHash) void import("./artwork").then((m) => m.queueArtworkFill()).catch(() => {});
  return { id: row.id, created: true };
}

// ---------- scanning ----------
export interface MusicScanStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { dir: string; seen: number; indexed: number; skipped: number; failed: number } | null;
  last: { dirs: string[]; seen: number; added: number; updated: number; failed: number; missing: number; errors: string[] } | null;
}
const g = globalThis as unknown as { __riftMusicScan?: { status: MusicScanStatus; current: Promise<void> | null; started: boolean } };
const state = (g.__riftMusicScan ??= { status: { running: false, startedAt: null, finishedAt: null, progress: null, last: null }, current: null, started: false });
export const getMusicScanStatus = (): MusicScanStatus => ({ ...state.status });

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".")) yield* walk(p); }
    else if (e.isFile() && isMusicFile(e.name)) yield p;
  }
}

export function scanMusic(dirs?: string[]): Promise<void> {
  if (state.current) return state.current;
  state.current = (async () => {
    const st = state.status;
    st.running = true; st.startedAt = new Date().toISOString();
    const list = [...new Set(dirs?.length ? dirs : (await getSettings()).musicLibraryDirs)];
    const rep = { dirs: list, seen: 0, added: 0, updated: 0, failed: 0, missing: 0, errors: [] as string[] };
    try {
      const present = new Set<string>();
      for (const dir of list) {
        const prog = (st.progress = { dir, seen: 0, indexed: 0, skipped: 0, failed: 0 });
        const files: string[] = [];
        for await (const f of walk(dir)) files.push(f);
        let i = 0;
        const worker = async () => {
          for (;;) {
            const f = files[i++];
            if (!f) return;
            present.add(f); prog.seen++; rep.seen++;
            try {
              const r = await indexFile(f, "import");
              if (r.created) { rep.added++; prog.indexed++; } else prog.skipped++;
            } catch (e) {
              prog.failed++; rep.failed++;
              if (rep.errors.length < 10) rep.errors.push(`${path.basename(f)}: ${(e as Error).message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
      }
      // Tracks whose files vanished (only judged for the directories scanned).
      const rows = await db.musicTrack.findMany({ select: { id: true, path: true, status: true } });
      for (const r of rows) {
        const inScope = list.some((d) => r.path.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
        if (!inScope) continue;
        const gone = !present.has(r.path);
        if (gone && r.status !== "missing") { await db.musicTrack.update({ where: { id: r.id }, data: { status: "missing" } }); rep.missing++; }
        else if (!gone && r.status === "missing") await db.musicTrack.update({ where: { id: r.id }, data: { status: "ready" } });
      }
    } catch (e) {
      rep.errors.push((e as Error).message);
    } finally {
      st.running = false; st.progress = null; st.finishedAt = new Date().toISOString(); st.last = rep; state.current = null;
      void import("./artwork").then((m) => m.queueArtworkFill()).catch(() => {});
    }
  })();
  return state.current;
}

export function startMusicWatcher() {
  if (state.started) return;
  state.started = true;
  setTimeout(() => void scanMusic().catch(() => {}), 8000).unref();
  setInterval(() => void scanMusic().catch(() => {}), 10 * 60_000).unref();
}
