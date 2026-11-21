import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { route, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { importFile, ImportError } from "@/server/library/importer";
import { isVideoFile } from "@/server/library/filename";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const clean = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 200);

/**
 * Streams an uploaded video straight to disk (no buffering), then probes/imports it.
 * PUT /api/admin/upload?filename=...&tmdbId=&mediaType=movie|tv&season=&episode=   (body = raw file bytes)
 */
export const PUT = route("admin", async ({ req }) => {
  const sp = req.nextUrl.searchParams;
  const filename = clean(sp.get("filename") ?? "");
  if (!filename || !isVideoFile(filename)) throw new HttpError(400, "Upload a video file (mkv, mp4, avi, mov, webm, ...)");
  if (!req.body) throw new HttpError(400, "Empty body");
  const tmdbId = Number(sp.get("tmdbId")) || 0;
  const mediaType: "movie" | "tv" | null = sp.get("mediaType") === "tv" ? "tv" : sp.get("mediaType") === "movie" ? "movie" : null;
  const season = sp.get("season") ? Number(sp.get("season")) : undefined;
  const episode = sp.get("episode") ? Number(sp.get("episode")) : undefined;

  const s = await getSettings();
  const declared = Number(req.headers.get("content-length")) || 0;
  const free = await statfs(s.uploadDir).catch(() => null);
  if (free && declared && declared > Number(free.bavail) * Number(free.bsize) - 512 * 1024 * 1024) throw new HttpError(507, "Not enough free disk space for this upload");

  // Organise: uploads/<movie|show tmdb folder>/filename so repeated names don't collide
  const sub = mediaType && tmdbId ? `${mediaType === "tv" ? "tv" : "movies"}-${tmdbId}` : "unsorted";
  const dir = path.join(s.uploadDir, sub);
  await mkdir(dir, { recursive: true });
  let dest = path.join(dir, filename);
  if (await fileExists(dest)) dest = path.join(dir, `${Date.now()}-${filename}`);
  const part = dest + ".part";
  try {
    await pipeline(Readable.fromWeb(req.body as never), createWriteStream(part));
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw new HttpError(499, `Upload interrupted: ${(e as Error).message}`);
  }
  try {
    const hint = mediaType && tmdbId ? { tmdbId, mediaType, season, episode } : undefined;
    const result = await importFile(dest, { source: "upload", hint });
    return { ok: true, result };
  } catch (e) {
    await rm(dest, { force: true });
    if (e instanceof ImportError) throw new HttpError(e.status, e.message);
    throw new HttpError(422, `Upload saved but could not be analysed: ${(e as Error).message}`);
  }
});

async function fileExists(p: string) {
  const { access } = await import("node:fs/promises");
  return access(p).then(() => true, () => false);
}
