import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { startHlsSession, WorkerError } from "@/server/transcode";

/** Starts (or reuses) an FFmpeg HLS session on the worker for this file. */
export const POST = route<{ id: string }>("profile", async ({ req, params }) => {
  const d = await body(req, z.object({ audioIndex: z.number().int().min(0).max(64).optional(), maxHeight: z.number().int().min(144).max(4320).optional() }));
  const file = await db.mediaFile.findUnique({ where: { id: params.id }, select: { id: true, path: true, status: true } });
  if (!file || file.status === "missing") throw new HttpError(404, "Media not found");
  const settings = await getSettings();
  const ladder = [...new Set(settings.transcodeLadder)].filter((h) => !d.maxHeight || h <= d.maxHeight).sort((a, b) => b - a);
  if (!ladder.length) ladder.push(d.maxHeight ?? 480);
  const key = createHash("sha1").update(`${ladder.join(",")}|${settings.hwaccel}`).digest("hex").slice(0, 8);
  const sessionId = `${file.id}-a${d.audioIndex ?? "x"}-${key}`;
  try {
    const r = await startHlsSession({ sessionId, inputPath: file.path, audioStreamIndex: d.audioIndex, ladder, hwaccel: settings.hwaccel });
    return { sessionId, masterUrl: `/api/hls/${sessionId}/master.m3u8`, variants: r.variants, duration: r.duration };
  } catch (e) {
    if (e instanceof WorkerError) throw new HttpError(e.status === 429 ? 429 : 503, e.message);
    throw e;
  }
});
