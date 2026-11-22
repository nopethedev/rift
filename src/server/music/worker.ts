import "server-only";
import { HttpError } from "../api";
import { workerFetch } from "../transcode";
import type { Candidate, EntryStatus, MusicConfig, MusicStats, PrepareRequest, ReleaseRequest, TrackQuery } from "@shared/music-protocol";

async function call<T>(path: string, body?: unknown, timeoutMs = 40_000): Promise<T> {
  let res: Response;
  try {
    res = await workerFetch(`/music/${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new HttpError(503, "The Rift worker is unreachable, so on-demand music is unavailable.");
  }
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new HttpError(res.status === 429 ? 429 : res.status === 404 || res.status === 403 || res.status === 503 ? res.status : 502, msg ?? `Worker error ${res.status}`);
  }
  return (await res.json()) as T;
}

export const musicWorker = {
  prepare: (r: PrepareRequest) => call<EntryStatus>("prepare", r),
  release: (r: ReleaseRequest) => call<{ ok: true }>("release", r),
  ping: (holder: string, ttlSec?: number) => call<{ held: number }>("ping", { holder, ttlSec }),
  status: (keys: string[]) => call<Record<string, EntryStatus>>("status", { keys }),
  search: (cfg: MusicConfig, q: string, limit = 10) => call<{ candidates: Candidate[] }>("search", { cfg, q, limit }, 60_000),
  resolve: (cfg: MusicConfig, query: TrackQuery) => call<{ candidates: Candidate[] }>("resolve", { cfg, query }, 90_000),
  stats: (cfg: MusicConfig) => call<MusicStats>("stats", { cfg }, 15_000),
  clear: (cfg: MusicConfig) => call<{ removed: number }>("clear", { cfg }),
  lavalinkTest: (node: { id: string; name: string; url: string; password: string; searchPrefix: string }) =>
    call<{ ok: boolean; version?: string; sources?: string[]; plugins?: { name: string; version: string }[]; sinkReady?: boolean; sinkEndpoint?: string; error?: string }>("lavalink-test", { node }, 20_000),
};

/** Proxies an audio request to the worker, forwarding Range and cancellation. */
export async function proxyWorkerAudio(path: string, req: Request): Promise<Response> {
  let up: Response;
  try {
    const headers: Record<string, string> = {};
    const range = req.headers.get("range");
    if (range) headers.range = range;
    up = await workerFetch(`/music/${path}`, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: req.signal });
  } catch {
    throw new HttpError(503, "The Rift worker is unreachable.");
  }
  if (!up.ok && up.status !== 206) {
    const msg = await up.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new HttpError(up.status === 429 || up.status === 404 || up.status === 416 ? up.status : 502, msg ?? `Worker error ${up.status}`);
  }
  const h = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "x-rift-audio"]) { const v = up.headers.get(k); if (v) h.set(k, v); }
  h.set("cache-control", "private, no-store");
  return new Response(up.body, { status: up.status, headers: h });
}
