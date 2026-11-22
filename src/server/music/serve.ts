import "server-only";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "../api";

const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg; codecs=opus", ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".wma": "audio/x-ms-wma" };
export const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** Streams a file with HTTP Range support so the browser can seek and buffer. */
export async function serveFile(req: Request, file: string): Promise<Response> {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, "File not found");
  const size = st.size;
  const headers: Record<string, string> = { "content-type": mimeFor(file), "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  const range = req.headers.get("range");
  let start = 0, end = size - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = String(end - start + 1);
  if (req.method === "HEAD") return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end });
  req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
