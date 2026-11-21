import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { db } from "@/server/db";
import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
  ".ts": "video/mp2t", ".avi": "video/x-msvideo", ".ogv": "video/ogg",
};

/** Direct file delivery with HTTP Range support (used by direct play and by Mediabunny's UrlSource). */
async function serve(req: NextRequest, ctx: { params: Promise<{ id: string }> }, head: boolean) {
  if (!(await getAuth())) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const file = await db.mediaFile.findUnique({ where: { id }, select: { path: true, status: true } });
  if (!file || file.status === "missing") return new Response("Not found", { status: 404 });
  const st = await stat(file.path).catch(() => null);
  if (!st?.isFile()) return new Response("File missing on disk", { status: 404 });

  const size = st.size;
  const etag = `W/"${st.mtimeMs.toString(36)}-${size.toString(36)}"`;
  const base: Record<string, string> = {
    "content-type": MIME[path.extname(file.path).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, must-revalidate",
    etag,
    "last-modified": st.mtime.toUTCString(),
  };
  if (req.headers.get("if-none-match") === etag && !req.headers.has("range")) return new Response(null, { status: 304, headers: base });

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    if (m[1] === "") {
      const n = Math.min(Number(m[2]), size);
      start = size - n;
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    status = 206;
    base["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  base["content-length"] = String(end - start + 1);
  if (head) return new Response(null, { status, headers: base });

  const stream = createReadStream(file.path, { start, end, highWaterMark: 256 * 1024 });
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers: base });
}

export const GET = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => serve(req, ctx, false);
export const HEAD = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => serve(req, ctx, true);
