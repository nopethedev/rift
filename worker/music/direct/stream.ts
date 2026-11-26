// Downloads a DirectAudio into a Readable for the music cache (ffmpeg reads it from a pipe).
import { PassThrough } from "node:stream";
import { EngineError, type AudioSource } from "../engines/types";
import type { DirectAudio } from "./types";

/** 10 MB ranges: below the size where Google's CDN starts throttling a request to playback speed. */
export const CHUNK_BYTES = 10 * 1024 * 1024;
const RETRIES = 3;

async function get(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await fetch(url, { headers, signal });
      if (r.ok || r.status === 206) return r;
      last = new EngineError(`The source's server answered ${r.status}`, r.status === 403 || r.status === 404 || r.status === 410 ? "not-found" : "failed");
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { if (signal.aborted) throw e; last = e; }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  throw last instanceof EngineError ? last : new EngineError(`Download failed: ${(last as Error)?.message ?? last}`, "failed");
}

async function pump(body: ReadableStream<Uint8Array> | null, out: PassThrough, signal: AbortSignal): Promise<number> {
  if (!body) return 0;
  let n = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    if (signal.aborted) break;
    n += chunk.length;
    if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", res));
  }
  return n;
}

/** Plain file, in ranges when asked (YouTube): `&range=a-b` in the URL works without a Range header round trip. */
async function download(a: DirectAudio, out: PassThrough, signal: AbortSignal) {
  if (!a.chunked) { await pump((await get(a.url, a.headers, signal)).body, out, signal); return; }
  let start = 0;
  const total = a.contentLength;
  for (;;) {
    const end = start + CHUNK_BYTES - 1;
    const u = new URL(a.url);
    u.searchParams.set("range", `${start}-${total ? Math.min(end, total - 1) : end}`);
    const n = await pump((await get(u.toString(), a.headers, signal)).body, out, signal);
    start += n;
    if (signal.aborted || n === 0 || n < CHUNK_BYTES || (total && start >= total)) break;
  }
}

/** HLS: fetch the playlist, then each segment in order (MP3 segments concatenate into one valid stream). */
async function downloadHls(a: DirectAudio, out: PassThrough, signal: AbortSignal) {
  const playlist = await (await get(a.url, a.headers, signal)).text();
  const segments = parsePlaylist(playlist, a.url);
  if (!segments.length) throw new EngineError("Empty HLS playlist", "failed");
  for (const s of segments) {
    if (signal.aborted) break;
    await pump((await get(s, a.headers, signal)).body, out, signal);
  }
}

export function parsePlaylist(text: string, base: string): string[] {
  if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(text)) throw new EngineError("Encrypted HLS is not supported", "failed");
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, base).toString());
}

/** Starts the download and returns it as an AudioSource (not realtime: it runs as fast as the CDN allows). */
export function openDirect(a: DirectAudio): AudioSource {
  const out = new PassThrough({ highWaterMark: 1024 * 1024 });
  const ac = new AbortController();
  const done = (a.hls ? downloadHls(a, out, ac.signal) : download(a, out, ac.signal)).then(
    () => { out.end(); },
    (e: unknown) => { const err = ac.signal.aborted ? new EngineError("closed") : e instanceof EngineError ? e : new EngineError(String((e as Error)?.message ?? e)); out.destroy(err); throw err; },
  );
  done.catch(() => {});
  return { stream: out, realtime: false, done, close: () => { ac.abort(); out.destroy(); } };
}
