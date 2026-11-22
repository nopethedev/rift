import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { serveFile } from "@/server/music/serve";
import { proxyWorkerAudio } from "@/server/music/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** Direct file (with Range) when the browser can decode it; `?transcode=1&start=<sec>` converts through the worker's FFmpeg. */
export const GET = route<{ id: string }>("profile", async ({ req, params }) => {
  const t = await db.musicTrack.findUnique({ where: { id: params.id } });
  if (!t || t.status !== "ready") throw new HttpError(404, "Track not found");
  const sp = req.nextUrl.searchParams;
  if (sp.get("transcode") === "1") {
    const s = await getSettings();
    const start = Math.max(0, Number(sp.get("start")) || 0);
    const fmt = sp.get("format") === "aac" ? "aac" : "mp3";
    return proxyWorkerAudio(`transcode?path=${encodeURIComponent(t.path)}&format=${fmt}&bitrate=${Math.min(320, s.musicBitrate)}&start=${start}`, req);
  }
  return serveFile(req, t.path);
});
