import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, statfs, access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { route, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { indexFile, isMusicFile } from "@/server/music/library";
import { invalidateMatchIndex } from "@/server/music/catalog";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;
const clean = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 200);

/** PUT /api/admin/music/upload?filename=song.flac  (body = raw bytes). Streams to disk, then reads tags + cover. */
export const PUT = route("admin", async ({ req }) => {
  const filename = clean(req.nextUrl.searchParams.get("filename") ?? "");
  if (!filename || !isMusicFile(filename)) throw new HttpError(400, "Upload an audio file (mp3, flac, aac, m4a, ogg, opus, wav, ...)");
  if (!req.body) throw new HttpError(400, "Empty body");
  const s = await getSettings();
  const declared = Number(req.headers.get("content-length")) || 0;
  const free = await statfs(s.musicUploadDir).catch(() => null);
  if (free && declared && declared > Number(free.bavail) * Number(free.bsize) - 256 * 1024 * 1024) throw new HttpError(507, "Not enough free disk space for this upload");
  await mkdir(s.musicUploadDir, { recursive: true });
  let dest = path.join(s.musicUploadDir, filename);
  if (await access(dest).then(() => true, () => false)) dest = path.join(s.musicUploadDir, `${Date.now()}-${filename}`);
  const part = dest + ".part";
  try {
    await pipeline(Readable.fromWeb(req.body as never), createWriteStream(part));
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true });
    throw new HttpError(499, `Upload interrupted: ${(e as Error).message}`);
  }
  try {
    const r = await indexFile(dest, "upload");
    invalidateMatchIndex();
    return { ok: true, id: r.id };
  } catch (e) {
    await rm(dest, { force: true });
    throw new HttpError(422, `Not a readable audio file: ${(e as Error).message}`);
  }
});
