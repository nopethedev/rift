// HTTP routes under /whisper (called from worker/server.ts after bearer auth).
import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "../sessions";
import type { WhisperJobs } from "./jobs";
import { whisperInstalled, WHISPER_MODELS, WhisperUnavailableError } from "./transcriber";

export interface WhisperService {
  jobs: WhisperJobs;
  stop(): Promise<void>;
}
export interface RouteHelpers {
  readJson(req: http.IncomingMessage): Promise<unknown>;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
}

const startSchema = z.object({
  inputPath: z.string().min(1).max(4000).refine((p) => path.isAbsolute(p) && !p.includes("\0"), "inputPath must be an absolute path"),
  audioStreamIndex: z.number().int().min(0).max(255).optional(),
  startSec: z.number().min(0).max(1_000_000).optional(),
  language: z.string().regex(/^(auto|[a-z]{2,3})$/),
  translate: z.boolean().default(false),
  model: z.enum(WHISPER_MODELS),
  threads: z.number().int().min(1).max(32).optional(),
});
const ID = /^[0-9a-f]{32}$/;

export async function handleWhisper(svc: WhisperService, req: http.IncomingMessage, res: http.ServerResponse, parts: string[], h: RouteHelpers): Promise<void> {
  const method = req.method ?? "GET";
  const sub = parts[1];
  try {
    if (method === "GET" && sub === "status" && parts.length === 2) {
      const inst = await whisperInstalled();
      return h.sendJson(res, 200, { installed: inst.installed, error: inst.error, models: WHISPER_MODELS, ...svc.jobs.load() });
    }
    if (method === "POST" && sub === "start") {
      const b = startSchema.parse(await h.readJson(req));
      const inst = await whisperInstalled();
      if (!inst.installed) throw new HttpError(503, inst.error ?? "Speech-to-text is not installed on the worker");
      if (svc.jobs.load().queued >= 20) throw new HttpError(429, "Too many subtitle jobs are waiting. Try again later.");
      return h.sendJson(res, 200, await svc.jobs.start(b));
    }
    if (sub === "jobs" && parts[2] && ID.test(parts[2])) {
      const id = parts[2];
      if (method === "GET" && parts.length === 3) {
        const st = svc.jobs.get(id);
        if (!st) throw new HttpError(404, "unknown job");
        return h.sendJson(res, 200, st);
      }
      if (method === "GET" && parts[3] === "vtt") {
        const v = svc.jobs.vtt(id);
        if (v === null) throw new HttpError(404, "unknown job");
        res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(v) });
        return void res.end(v);
      }
      if (method === "DELETE" && parts.length === 3) return h.sendJson(res, 200, { cancelled: svc.jobs.cancel(id) });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (e instanceof WhisperUnavailableError) throw new HttpError(503, e.message);
    throw new HttpError(500, (e as Error).message);
  }
  throw new HttpError(404, "not found");
}
