import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { env } from "@/server/config";
import { registerSubtitleFile } from "@/server/library/importer";
import { SUBTITLE_EXTENSIONS } from "@shared/subtitles";

type P = { id: string };

/** Upload a subtitle (.srt / .vtt / .ass / .ssa); it is converted to WebVTT. multipart: file, language?, label? */
export const POST = route<P>("admin", async ({ req, params }) => {
  const f = await db.mediaFile.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!f) throw new HttpError(404, "File not found");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Missing subtitle file");
  const ext = path.extname(file.name).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.includes(ext)) throw new HttpError(400, "Supported subtitle formats: SRT, VTT, ASS, SSA");
  if (file.size > 5 * 1024 * 1024) throw new HttpError(413, "Subtitle file too large");
  const tmpDir = path.join(env.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${randomUUID()}${ext}`);
  await writeFile(tmp, Buffer.from(await file.arrayBuffer()));
  try {
    const lang = String(form.get("language") ?? "").trim() || undefined;
    const label = String(form.get("label") ?? "").trim() || undefined;
    const sub = await registerSubtitleFile(f.id, tmp, { language: lang, label: label ?? file.name.replace(/\.[^.]+$/, ""), source: "upload" });
    return { ok: true, subtitle: sub };
  } catch (e) {
    throw new HttpError(422, `Could not convert subtitle: ${(e as Error).message}`);
  } finally {
    await rm(tmp, { force: true });
  }
});
