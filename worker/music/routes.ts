// HTTP routes under /music (called from worker/server.ts after bearer auth).
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import { AUDIO_MIME, type AudioFormat, type MusicStats } from "../../shared/music-protocol";
import { BusyError, ffmpegArgs, type MusicCache } from "./cache";
import { EngineError, type Engine } from "./engines/types";
import { ytdlpVersion } from "./engines/ytdlp";
import { LavalinkNode, type LavalinkPool } from "./lavalink";
import { HttpError } from "../sessions";
import type { VoiceSink } from "./voice-sink";

export interface MusicService {
  cache: MusicCache;
  pool: LavalinkPool;
  engines: Record<string, Engine>;
  sink(): VoiceSink | null;
  stop(): Promise<void>;
}

export interface RouteHelpers {
  readJson(req: http.IncomingMessage): Promise<unknown>;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
}

const node = z.object({ id: z.string().max(64), name: z.string().max(80), url: z.string().url(), password: z.string().max(300), searchPrefix: z.string().max(40) });
const cfgSchema = z.object({
  engine: z.enum(["ytdlp", "lavalink"]),
  cacheDir: z.string().max(500),
  maxCacheMB: z.number().min(16).max(10_000_000),
  cleanup: z.boolean(),
  cleanupGraceSec: z.number().min(0).max(86400),
  format: z.enum(["mp3", "aac", "opus"]),
  bitrateKbps: z.number().int().min(32).max(512),
  maxDownloads: z.number().int().min(1).max(16),
  maxStreams: z.number().int().min(0).max(1000),
  licensePolicy: z.enum(["licensed-only", "attested"]),
  ytdlp: z.object({ providers: z.array(z.enum(["youtube", "soundcloud"])).max(2), binary: z.string().max(300) }),
  lavalink: z.object({ nodes: z.array(node).max(20), allowedSources: z.array(z.string().max(40)).max(30) }),
});
const query = z.object({ title: z.string().min(1).max(300), artist: z.string().max(300), album: z.string().max(300).optional(), durationSec: z.number().min(0).max(36000).optional(), allowVariants: z.boolean().optional() });
const candidate = z.object({ engine: z.enum(["ytdlp", "lavalink"]), sourceId: z.string().max(500), title: z.string().max(500), artist: z.string().max(300), durationSec: z.number(), url: z.string().max(2000), score: z.number(), license: z.string().nullish().transform((v) => v ?? undefined), artworkUrl: z.string().nullish().transform((v) => v ?? undefined), encoded: z.string().nullish().transform((v) => v ?? undefined), nodeId: z.string().nullish().transform((v) => v ?? undefined), sourceName: z.string().nullish().transform((v) => v ?? undefined) });
const prepareSchema = z.object({ cfg: cfgSchema, query: query.optional(), candidate: candidate.optional(), holder: z.string().min(1).max(100), role: z.enum(["current", "preload"]), ttlSec: z.number().min(5).max(3600).optional() });
const releaseSchema = z.object({ holder: z.string().min(1).max(100), role: z.enum(["current", "preload"]).optional(), keep: z.array(z.string()).max(50).optional(), key: z.string().max(64).optional() });

function parseRange(h: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number, end: number;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? "invalid" : { start, end };
}

const KEY_RE = /^[0-9a-f]{24}$/;
let transcodes = 0;

export async function handleMusic(svc: MusicService, req: http.IncomingMessage, res: http.ServerResponse, parts: string[], h: RouteHelpers): Promise<void> {
  const method = req.method ?? "GET";
  const isGet = method === "GET" || method === "HEAD";
  const { cache } = svc;
  const sub = parts[1];
  const fail = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    if (e instanceof BusyError) throw new HttpError(429, e.message);
    if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (e instanceof EngineError) throw new HttpError(e.code === "unavailable" ? 503 : e.code === "not-found" ? 404 : e.code === "unlicensed" ? 403 : 502, e.message);
    throw e;
  };

  try {
    if (method === "POST" && sub === "prepare") {
      const b = prepareSchema.parse(await h.readJson(req));
      return h.sendJson(res, 200, await cache.prepare(b));
    }
    if (method === "POST" && sub === "release") {
      cache.release(releaseSchema.parse(await h.readJson(req)));
      return h.sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && sub === "ping") {
      const b = z.object({ holder: z.string().min(1).max(100), ttlSec: z.number().min(5).max(3600).optional() }).parse(await h.readJson(req));
      return h.sendJson(res, 200, { held: cache.ping(b.holder, b.ttlSec) });
    }
    if (method === "POST" && sub === "status") {
      const b = z.object({ keys: z.array(z.string().regex(KEY_RE)).max(50) }).parse(await h.readJson(req));
      const out: Record<string, unknown> = {};
      for (const k of b.keys) { const e = cache.get(k); if (e) out[k] = cache.status(e); }
      return h.sendJson(res, 200, out);
    }
    if (method === "POST" && sub === "search") {
      const b = z.object({ cfg: cfgSchema, q: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) }).parse(await h.readJson(req));
      const engine = svc.engines[b.cfg.engine];
      return h.sendJson(res, 200, { candidates: await engine.search(b.q, b.cfg, b.limit) });
    }
    if (method === "POST" && sub === "resolve") {
      // Resolve only (no download): which recordings would be used for this song?
      const b = z.object({ cfg: cfgSchema, query }).parse(await h.readJson(req));
      await cache.configure(b.cfg);
      return h.sendJson(res, 200, { candidates: await cache.resolve(b.query, b.cfg) });
    }
    if (method === "POST" && sub === "stats") {
      const b = z.object({ cfg: cfgSchema }).parse(await h.readJson(req));
      await cache.configure(b.cfg);
      if (b.cfg.lavalink.nodes.length) svc.pool.sync(b.cfg.lavalink.nodes);
      const sink = svc.sink();
      const body: MusicStats = {
        engine: b.cfg.engine,
        ...cache.stats(),
        ytdlp: await ytdlpVersion(b.cfg).then((v) => ({ available: !!v, version: v ?? undefined })),
        lavalink: {
          nodes: svc.pool.all().map((n) => ({ id: n.cfg.id, name: n.cfg.name, online: n.online, players: n.players, version: n.version, error: n.online ? undefined : n.lastError })),
          sinkReady: !!sink,
          sinkEndpoint: sink?.endpoint,
        },
      };
      return h.sendJson(res, 200, body);
    }
    if (method === "POST" && sub === "clear") {
      const b = z.object({ cfg: cfgSchema }).parse(await h.readJson(req));
      await cache.configure(b.cfg);
      return h.sendJson(res, 200, { removed: await cache.clear() });
    }
    if (method === "POST" && sub === "lavalink-test") {
      const b = z.object({ node }).parse(await h.readJson(req));
      const n = new LavalinkNode(b.node);
      n.connect();
      try {
        const info = await n.info();
        await n.waitReady(6000);
        const sink = svc.sink();
        return h.sendJson(res, 200, { ok: true, version: info.version, sources: info.sourceManagers, plugins: info.plugins, sinkReady: !!sink, sinkEndpoint: sink?.endpoint });
      } catch (e) {
        return h.sendJson(res, 200, { ok: false, error: (e as Error).message });
      } finally { n.close(); }
    }

    if (isGet && sub === "audio" && parts.length === 3) {
      if (!KEY_RE.test(parts[2])) throw new HttpError(400, "invalid key");
      const entry = cache.get(parts[2]);
      if (!entry) throw new HttpError(404, "unknown or expired audio; prepare it again");
      return await serveAudio(svc, entry, req, res);
    }
    if (isGet && sub === "transcode") return await serveTranscode(req, res);
  } catch (e) {
    return fail(e);
  }
  throw new HttpError(404, "not found");
}

async function serveAudio(svc: MusicService, entry: NonNullable<ReturnType<MusicCache["get"]>>, req: http.IncomingMessage, res: http.ServerResponse) {
  const { cache } = svc;
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  let job;
  try { job = await cache.waitStreamable(entry); } catch (e) { throw new HttpError(e instanceof EngineError && e.code === "unavailable" ? 503 : 502, (e as Error).message); }
  const mime = AUDIO_MIME[job.format];
  const head = req.method === "HEAD";
  const range = req.headers.range;
  const wantsOffset = !!range && !/^bytes=0-/.test(range.trim());

  if (job.state === "running" && wantsOffset) {
    // A seek past what exists: only possible once the file is complete.
    try { await cache.waitReady(job, 90_000); } catch (e) { throw new HttpError(503, `Audio is still being captured: ${(e as Error).message}`); }
  }
  if (job.state === "ready") {
    const size = await cache.finalSize(job).catch(() => { throw new HttpError(404, "audio was cleaned up; prepare it again"); });
    const r = parseRange(range, size);
    if (r === "invalid") { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return void res.end(); }
    const headers: http.OutgoingHttpHeaders = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=0", "X-Rift-Audio": "cached" };
    if (r) { res.writeHead(206, { ...headers, "Content-Range": `bytes ${r.start}-${r.end}/${size}`, "Content-Length": r.end - r.start + 1 }); }
    else res.writeHead(200, { ...headers, "Content-Length": size });
    job.lastUsed = Date.now();
    if (head) return void res.end();
    const s = cache.openFinal(job, r ? { start: r.start, end: r.end } : undefined);
    s.on("error", () => res.destroy());
    res.on("close", () => s.destroy());
    s.pipe(res);
    return;
  }
  // Still being written: stream from the start as bytes arrive.
  res.writeHead(200, { "Content-Type": mime, "Accept-Ranges": "none", "Cache-Control": "no-store", "X-Rift-Audio": "live" });
  if (head) return void res.end();
  try {
    for await (const chunk of cache.tail(job, ac.signal)) {
      if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]);
      if (res.destroyed) return;
    }
    res.end();
  } catch {
    res.destroy(); // mid-stream failure: truncated body tells the player to recover
  }
}

async function serveTranscode(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? "/", "http://x");
  const file = u.searchParams.get("path") ?? "";
  const format = (u.searchParams.get("format") ?? "mp3") as AudioFormat;
  const bitrate = Math.min(320, Math.max(64, Number(u.searchParams.get("bitrate")) || 192));
  const start = Math.max(0, Number(u.searchParams.get("start")) || 0);
  if (!path.isAbsolute(file) || file.includes("\0")) throw new HttpError(400, "invalid path");
  if (!(format in AUDIO_MIME)) throw new HttpError(400, "invalid format");
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, "file not found");
  if (transcodes >= Number(process.env.MUSIC_MAX_TRANSCODES || 6)) throw new HttpError(429, "too many audio conversions running");
  transcodes++;
  const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", ffmpegArgs({ format, bitrateKbps: bitrate }, file, start > 0 ? ["-ss", String(start)] : []), { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d: Buffer) => { err = (err + d).slice(-300); });
  const release = () => { transcodes--; };
  ff.once("close", release);
  res.on("close", () => ff.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    ff.stdout.once("readable", () => resolve());
    ff.once("close", () => reject(new HttpError(502, `ffmpeg failed${err ? `: ${err.trim()}` : ""}`)));
    ff.once("error", (e) => reject(new HttpError(503, e.message)));
  });
  res.writeHead(200, { "Content-Type": AUDIO_MIME[format], "Accept-Ranges": "none", "Cache-Control": "no-store", "X-Rift-Audio": "transcode" });
  ff.stdout.pipe(res);
}
