import "server-only";
import { HttpError } from "./api";
import { workerFetch } from "./transcode";

// Client for the worker's /whisper endpoints (speech-to-text jobs). Types mirror worker/whisper/jobs.ts.
export type WhisperJobState = "queued" | "loading" | "detecting" | "running" | "done" | "failed" | "cancelled";
export interface WhisperJob {
  id: string; state: WhisperJobState; progress: number; coveredSec: number; durationSec: number; language?: string; detected?: { lang: string; confidence: number };
  translate: boolean; model: string; version: number; cues: number; speed?: number; queuePosition?: number; error?: string; startedAt: number; finishedAt?: number;
}
export interface WhisperStartRequest { inputPath: string; audioStreamIndex?: number; startSec?: number; language: string; translate: boolean; model: string }
export interface WhisperWorkerStatus { installed: boolean; error?: string; running: number; queued: number }

async function call(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let res: Response;
  try { res = await workerFetch(`/whisper/${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new HttpError(503, "The Rift worker is unreachable, so subtitles cannot be generated."); }
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new HttpError(res.status === 429 || res.status === 404 || res.status === 503 || res.status === 400 ? res.status : 502, msg ?? `Worker error ${res.status}`);
  }
  return res;
}
const json = <T>(r: Response) => r.json() as Promise<T>;

export const whisperWorker = {
  status: async () => json<WhisperWorkerStatus>(await call("status", {}, 8_000)),
  start: async (r: WhisperStartRequest) => json<WhisperJob>(await call("start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) })),
  job: async (id: string) => json<WhisperJob>(await call(`jobs/${id}`, {}, 10_000)),
  vtt: async (id: string) => (await call(`jobs/${id}/vtt`, {}, 30_000)).text(),
  cancel: async (id: string) => json<{ cancelled: boolean }>(await call(`jobs/${id}`, { method: "DELETE" }, 10_000)),
};
