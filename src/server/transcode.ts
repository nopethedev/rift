import "server-only";
import { execFile } from "node:child_process";
import { env } from "./config";
import type { SessionStatus, StartSessionRequest, StartSessionResponse, WorkerHealth } from "@shared/worker-protocol";

const auth = () => ({ Authorization: `Bearer ${env.workerToken}` });

export async function workerFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(env.workerUrl + pathname, {
    ...init,
    headers: { ...auth(), ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(40_000),
    cache: "no-store",
  });
}

export async function workerHealth(): Promise<WorkerHealth | null> {
  try {
    const r = await fetch(env.workerUrl + "/health", { signal: AbortSignal.timeout(3000), cache: "no-store" });
    return r.ok ? ((await r.json()) as WorkerHealth) : null;
  } catch {
    return null;
  }
}

function firstLine(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.env[cmd === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH"] || cmd, args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : stdout.split("\n")[0] || null),
    );
  });
}

/** FFmpeg availability on the web host + the state of the transcoding worker. */
export async function probeFfmpeg() {
  const [ffmpeg, ffprobe, worker] = await Promise.all([firstLine("ffmpeg", ["-version"]), firstLine("ffprobe", ["-version"]), workerHealth()]);
  return { ffmpeg, ffprobe, worker };
}

export class WorkerError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export async function startHlsSession(req: StartSessionRequest): Promise<StartSessionResponse> {
  let res: Response;
  try {
    res = await workerFetch("/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  } catch {
    throw new WorkerError("Transcoding worker is unreachable", 503);
  }
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new WorkerError(msg ?? `Worker error ${res.status}`, res.status === 429 ? 429 : 502);
  }
  return (await res.json()) as StartSessionResponse;
}

export async function listWorkerSessions(): Promise<SessionStatus[]> {
  try {
    const r = await workerFetch("/sessions", { signal: AbortSignal.timeout(4000) });
    return r.ok ? ((await r.json()) as SessionStatus[]) : [];
  } catch {
    return [];
  }
}

export async function stopWorkerSession(id: string) {
  await workerFetch(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}
