import path from "node:path";
import type { NextRequest } from "next/server";
import { getAuth } from "@/server/auth";
import { getTorrentStreamer } from "@/server/torrents/streamer";
import { TorrentError } from "@/server/torrents/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".ts": "video/mp2t", ".avi": "video/x-msvideo" };

/** HTTP range delivery straight from the torrent (blocks until the requested pieces arrive). */
async function serve(req: NextRequest, ctx: { params: Promise<{ id: string }> }, head: boolean) {
  const auth = await getAuth();
  if (!auth) return new Response("Unauthorized", { status: 401 });
  if (auth.user.role !== "ADMIN") return new Response("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  const st = getTorrentStreamer();
  let view;
  try {
    view = st.get(id);
  } catch (e) {
    return new Response(e instanceof TorrentError ? e.message : "Not found", { status: 404 });
  }
  if (view.status !== "ready" || !view.fileName) return new Response("Stream is not ready", { status: 409 });
  const size = view.fileSize;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "content-type": MIME[path.extname(view.fileName).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(end - start + 1);
  if (head) return new Response(null, { status, headers });
  try {
    const { chunks } = st.openRange(id, start, end);
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const { value, done } = await chunks.next();
          if (done) c.close();
          else c.enqueue(new Uint8Array(value));
        } catch (e) {
          c.error(e);
        }
      },
      cancel() { void chunks.return(undefined); },
    });
    req.signal.addEventListener("abort", () => void chunks.return(undefined), { once: true });
    return new Response(body, { status, headers });
  } catch (e) {
    if (!(e instanceof TorrentError)) console.error("[stream] range error:", e);
    return new Response(e instanceof TorrentError ? e.message : "Stream error", { status: e instanceof TorrentError ? e.status : 500 });
  }
}

export const GET = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => serve(req, ctx, false);
export const HEAD = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => serve(req, ctx, true);
