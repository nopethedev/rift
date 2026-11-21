// HTTP layer (node:http): routing, bearer auth, JSON and HLS responses.
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import type { WorkerHealth } from "../shared/worker-protocol";
import type { WorkerConfig } from "./config";
import { HttpError, SESSION_ID_RE, validateStartRequest, type SessionManager } from "./sessions";

export interface ServerDeps {
  cfg: WorkerConfig;
  sessions: SessionManager;
  ffmpegVersion: string;
  hwaccels: string[];
}

const MAX_BODY = 64 * 1024;
const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, type: string, body: string, head: boolean) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(head ? undefined : body);
}

/** Constant-time token check (hashing first makes the comparison length-independent). */
function authorized(req: http.IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !token) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

async function streamSegment(res: http.ServerResponse, file: string, head: boolean) {
  // The file is complete and never rewritten (ffmpeg renames finished segments into place); it may only
  // disappear if the session is deleted meanwhile, in which case the open stream keeps reading the unlinked inode.
  const stream = createReadStream(file);
  await new Promise<void>((resolve, reject) => {
    stream.once("open", () => resolve());
    stream.once("error", () => reject(new HttpError(404, "segment not found")));
  });
  const { size } = await fs.stat(file).catch(() => ({ size: -1 }));
  if (size < 0) {
    stream.destroy();
    throw new HttpError(404, "segment not found");
  }
  res.writeHead(200, {
    "Content-Type": "video/mp2t",
    "Content-Length": size,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  if (head) {
    stream.destroy();
    res.end();
    return;
  }
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Splits the URL path into decoded segments; rejects anything that could escape a directory. */
function pathParts(url: string): string[] | null {
  const pathname = url.split("?")[0];
  const raw = pathname.split("/").filter(Boolean);
  const parts: string[] = [];
  for (const p of raw) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (d === "." || d === ".." || d.includes("/") || d.includes("\\") || d.includes("\0")) return null;
    parts.push(d);
  }
  return parts;
}

export function createServer(deps: ServerDeps): http.Server {
  const { cfg, sessions } = deps;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method ?? "GET";
    const parts = pathParts(req.url ?? "/");
    if (!parts) throw new HttpError(400, "invalid path");
    const head = method === "HEAD";
    const isGet = method === "GET" || head;

    if (isGet && parts.length === 1 && parts[0] === "health") {
      const body: WorkerHealth = {
        ok: true,
        ffmpeg: deps.ffmpegVersion,
        hwaccels: deps.hwaccels,
        activeSessions: sessions.activeCount,
        maxSessions: cfg.maxSessions,
      };
      return sendJson(res, 200, body);
    }

    if (!authorized(req, cfg.token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new HttpError(401, "unauthorized");
    }

    // /sessions
    if (parts[0] === "sessions") {
      if (parts.length === 1) {
        if (method === "POST") return sendJson(res, 200, await sessions.create(validateStartRequest(await readJson(req))));
        if (isGet) return sendJson(res, 200, sessions.list());
        throw new HttpError(405, "method not allowed");
      }
      if (parts.length === 2) {
        const id = parts[1];
        if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid sessionId");
        if (isGet) return sendJson(res, 200, sessions.get(id));
        if (method === "DELETE") {
          if (!(await sessions.remove(id))) throw new HttpError(404, "session not found");
          return sendJson(res, 200, { ok: true });
        }
        throw new HttpError(405, "method not allowed");
      }
    }

    // /hls/:id/master.m3u8 | /hls/:id/v<h>/index.m3u8 | /hls/:id/v<h>/seg_<n>.ts
    if (parts[0] === "hls" && (parts.length === 3 || parts.length === 4)) {
      if (!isGet) throw new HttpError(405, "method not allowed");
      const id = parts[1];
      if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid sessionId");
      if (parts.length === 3) {
        if (parts[2] !== "master.m3u8") throw new HttpError(404, "not found");
        return sendText(res, 200, PLAYLIST_TYPE, sessions.master(id), head);
      }
      const vm = /^v(\d{2,4})$/.exec(parts[2]);
      if (!vm) throw new HttpError(404, "not found");
      const height = Number(vm[1]);
      if (parts[3] === "index.m3u8") return sendText(res, 200, PLAYLIST_TYPE, sessions.variantPlaylist(id, height), head);
      const sm = /^seg_(\d{1,6})\.ts$/.exec(parts[3]);
      if (!sm) throw new HttpError(404, "not found");
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      const file = await sessions.segment(id, height, Number(sm[1]), ac.signal);
      return streamSegment(res, file, head);
    }

    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error("[worker] request failed:", err);
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0; // segment waits can take up to 30 s
  return server;
}
