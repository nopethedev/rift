import "server-only";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db";
import { env } from "../config";
import { findAlbumArt, onlineEnabled } from "./online";
import { coverDir } from "./library";
import { artUrlAllowed } from "./art-hosts";

// ---------- remote image cache (used by the /api/music/art proxy) ----------
const artDir = () => path.join(env.dataDir, "music", "art");
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MAX_BYTES = 8 * 1024 * 1024;

async function readCached(hash: string): Promise<{ data: Buffer; mime: string } | null> {
  for (const ext of Object.keys(MIME)) {
    const data = await readFile(path.join(artDir(), `${hash}.${ext}`)).catch(() => null);
    if (data) return { data, mime: MIME[ext] };
  }
  return null;
}

/** Fetches (and caches on disk) an allow-listed remote image. Redirects are followed manually so every hop is re-checked. */
export async function fetchArt(raw: string): Promise<{ data: Buffer; mime: string } | null> {
  let u = artUrlAllowed(raw);
  if (!u) return null;
  const hash = createHash("sha1").update(u.href).digest("hex");
  const hit = await readCached(hash);
  if (hit) return hit;
  for (let hop = 0; hop < 3 && u; hop++) {
    const res: Response | null = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Rift/1.0", accept: "image/*" } }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) { const next: string | null = res.headers.get("location"); u = next ? artUrlAllowed(new URL(next, u).href) : null; continue; }
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > MAX_BYTES) return null;
    await mkdir(artDir(), { recursive: true });
    const tmp = path.join(artDir(), `${hash}.${ext}.tmp${process.pid}`);
    await writeFile(tmp, data);
    await rename(tmp, path.join(artDir(), `${hash}.${ext}`));
    return { data, mime: MIME[ext] };
  }
  return null;
}

// ---------- fill missing covers of library tracks ----------
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
function toJpeg(img: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), ["-v", "error", "-i", "pipe:0", "-an", "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "3", "-f", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.once("error", reject);
    p.once("close", (code) => { const b = Buffer.concat(out); code === 0 && b.length ? resolve(b) : reject(new Error("image conversion failed")); });
    p.stdin.on("error", () => {});
    p.stdin.end(img);
  });
}

export async function storeCoverFromUrl(url: string): Promise<string | null> {
  const img = await fetchArt(url);
  if (!img) return null;
  const jpg = await toJpeg(img.data).catch(() => null);
  if (!jpg) return null;
  const hash = createHash("sha1").update(jpg).digest("hex");
  await mkdir(coverDir(), { recursive: true });
  if (!(await stat(path.join(coverDir(), `${hash}.jpg`)).catch(() => null))) await writeFile(path.join(coverDir(), `${hash}.jpg`), jpg);
  return hash;
}

const RETRY_MS = 7 * 86400_000;
const gs = globalThis as unknown as { __riftArtFill?: { running: Promise<ArtFillResult> | null; timer: NodeJS.Timeout | null } };
const fill = (gs.__riftArtFill ??= { running: null, timer: null });
export interface ArtFillResult { albums: number; found: number; tracks: number }

/**
 * Looks up covers for library tracks that have none: one lookup per album (or per single), then every track of the album
 * gets the picture. Misses are remembered for a week so scans do not repeat them.
 */
export function fillMissingArtwork(force = false): Promise<ArtFillResult> {
  if (fill.running) return fill.running;
  fill.running = (async () => {
    const res: ArtFillResult = { albums: 0, found: 0, tracks: 0 };
    if (!(await onlineEnabled())) return res;
    const where = { status: "ready", coverHash: null, ...(force ? {} : { OR: [{ artTriedAt: null }, { artTriedAt: { lt: new Date(Date.now() - RETRY_MS) } }] }) };
    const rows = await db.musicTrack.findMany({ where, select: { id: true, albumKey: true, album: true, artist: true, albumArtist: true, title: true }, take: 3000 });
    const groups = new Map<string, typeof rows>();
    for (const r of rows) { const a = groups.get(r.albumKey); if (a) a.push(r); else groups.set(r.albumKey, [r]); }
    for (const list of groups.values()) {
      const t = list[0];
      res.albums++;
      let hash: string | null = null;
      try {
        const url = await findAlbumArt({ artist: t.album ? t.albumArtist ?? t.artist : t.artist, album: t.album, title: t.title });
        hash = url ? await storeCoverFromUrl(url) : null;
      } catch { /* offline or rate limited: try again next time */ continue; }
      const ids = list.map((x) => x.id);
      if (hash) { await db.musicTrack.updateMany({ where: { id: { in: ids } }, data: { coverHash: hash, artTriedAt: new Date() } }); res.found++; res.tracks += ids.length; }
      else await db.musicTrack.updateMany({ where: { id: { in: ids } }, data: { artTriedAt: new Date() } });
    }
    return res;
  })().finally(() => { fill.running = null; });
  return fill.running;
}

/** Debounced trigger for after scans/uploads. */
export function queueArtworkFill(delayMs = 4000) {
  if (fill.timer) clearTimeout(fill.timer);
  fill.timer = setTimeout(() => { fill.timer = null; void fillMissingArtwork().catch((e) => console.warn("[music] artwork lookup failed:", (e as Error).message)); }, delayMs);
  fill.timer.unref();
}
