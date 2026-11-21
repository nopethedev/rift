// Session registry: lifecycle, idle reaping, on-demand segment production with seek restarts and throttling.
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { firstAudio, firstVideo, probeFile, type ProbeResult } from "../shared/probe";
import type {
  HwAccel,
  SessionState,
  SessionStatus,
  StartSessionRequest,
  StartSessionResponse,
} from "../shared/worker-protocol";
import type { WorkerConfig } from "./config";
import { FfmpegRun, type ColorHandling } from "./ffmpeg";
import { pickEncoder, type Accel, type EncoderKind } from "./hwaccel";
import {
  SEGMENT_SECONDS,
  masterPlaylist,
  resolveLadder,
  segmentLayout,
  segmentName,
  variantDirName,
  variantPlaylist,
  type Rendition,
  type SegmentLayout,
} from "./playlist";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HWACCELS: HwAccel[] = ["none", "auto", "nvenc", "vaapi", "qsv", "videotoolbox"];
const MARKER = ".rift-session.json";

/** A missing segment at most this far past the encoder head is waited for instead of restarting ffmpeg. */
const LOOKAHEAD_SEGMENTS = 3;
/** The encoder is paused (SIGSTOP) when it gets this many segments ahead of the last requested one. */
const MAX_AHEAD_SEGMENTS = 20;
const SEGMENT_WAIT_MS = 30_000;
const POLL_MS = 150;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Capabilities {
  hwaccels: Accel[];
  toneMapping: boolean;
}

interface Variant {
  r: Rendition;
  dir: string;
  run?: FfmpegRun;
  lastRequested: number;
  lock: Promise<unknown>;
}

interface Session {
  id: string;
  req: StartSessionRequest;
  dir: string;
  probe: ProbeResult;
  videoIndex: number;
  audioIndex?: number;
  fps: number;
  color: ColorHandling;
  layout: SegmentLayout;
  variants: Variant[];
  encoder: EncoderKind;
  startedAt: number;
  lastAccessAt: number;
  producedAny: boolean;
  error?: string;
  deleted: boolean;
}

const sameParams = (a: StartSessionRequest, b: StartSessionRequest) =>
  a.inputPath === b.inputPath &&
  a.audioStreamIndex === b.audioStreamIndex &&
  a.hwaccel === b.hwaccel &&
  a.ladder.length === b.ladder.length &&
  a.ladder.every((h, i) => h === b.ladder[i]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function validateStartRequest(body: unknown): StartSessionRequest {
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON object body required");
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !SESSION_ID_RE.test(b.sessionId)) throw new HttpError(400, "invalid sessionId");
  if (typeof b.inputPath !== "string" || !b.inputPath || b.inputPath.includes("\0") || !path.isAbsolute(b.inputPath))
    throw new HttpError(400, "inputPath must be an absolute path");
  if (b.audioStreamIndex !== undefined && b.audioStreamIndex !== null && (!Number.isInteger(b.audioStreamIndex) || (b.audioStreamIndex as number) < 0))
    throw new HttpError(400, "audioStreamIndex must be a non-negative integer");
  if (!Array.isArray(b.ladder) || b.ladder.length > 12 || !b.ladder.every((h) => Number.isInteger(h) && h > 0 && h <= 4320))
    throw new HttpError(400, "ladder must be an array of positive integer heights");
  const hwaccel = (b.hwaccel ?? "none") as HwAccel;
  if (!HWACCELS.includes(hwaccel)) throw new HttpError(400, `hwaccel must be one of ${HWACCELS.join(", ")}`);
  if (b.startPosition !== undefined && (typeof b.startPosition !== "number" || !Number.isFinite(b.startPosition) || b.startPosition < 0))
    throw new HttpError(400, "startPosition must be a non-negative number");
  return {
    sessionId: b.sessionId,
    inputPath: path.normalize(b.inputPath),
    audioStreamIndex: (b.audioStreamIndex ?? undefined) as number | undefined,
    ladder: b.ladder as number[],
    hwaccel,
    startPosition: b.startPosition as number | undefined,
  };
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<StartSessionResponse>>();
  private reaper?: NodeJS.Timeout;

  constructor(
    private cfg: WorkerConfig,
    private caps: Capabilities,
  ) {}

  get activeCount() {
    return this.sessions.size;
  }

  /** Create the work dir, delete stale session dirs left by a previous process, start the idle reaper. */
  async init() {
    await fs.mkdir(this.cfg.transcodeDir, { recursive: true });
    for (const name of await fs.readdir(this.cfg.transcodeDir)) {
      if (!SESSION_ID_RE.test(name)) continue;
      const dir = path.join(this.cfg.transcodeDir, name);
      if (existsSync(path.join(dir, MARKER))) await fs.rm(dir, { recursive: true, force: true });
    }
    const every = Math.min(15_000, (this.cfg.idleSeconds * 1000) / 2);
    this.reaper = setInterval(() => void this.reapIdle(), every);
    this.reaper.unref();
  }

  private async reapIdle() {
    const cutoff = Date.now() - this.cfg.idleSeconds * 1000;
    for (const s of [...this.sessions.values()]) {
      if (s.lastAccessAt < cutoff) {
        console.log(`[worker] session ${s.id} idle for ${this.cfg.idleSeconds}s, removing`);
        await this.remove(s.id).catch(() => {});
      }
    }
  }

  private sessionDir(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid sessionId");
    const dir = path.join(this.cfg.transcodeDir, id);
    if (path.dirname(dir) !== this.cfg.transcodeDir) throw new HttpError(400, "invalid sessionId");
    return dir;
  }

  private require(id: string): Session {
    if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid sessionId");
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, "session not found");
    s.lastAccessAt = Date.now();
    return s;
  }

  // ---------------- create / reuse ----------------

  async create(req: StartSessionRequest): Promise<StartSessionResponse> {
    const inflight = this.pending.get(req.sessionId);
    if (inflight) {
      await inflight.catch(() => {});
      return this.create(req);
    }
    const existing = this.sessions.get(req.sessionId);
    if (existing) {
      if (!existing.error && sameParams(existing.req, req)) {
        existing.lastAccessAt = Date.now();
        return this.response(existing, true);
      }
      await this.remove(existing.id); // replaced: never counts against the limit
    } else if (this.sessions.size + this.pending.size >= this.cfg.maxSessions) {
      throw new HttpError(429, `worker is at its session limit (${this.cfg.maxSessions})`);
    }
    const p = this.doCreate(req);
    this.pending.set(req.sessionId, p);
    try {
      return await p;
    } finally {
      this.pending.delete(req.sessionId);
    }
  }

  private async doCreate(req: StartSessionRequest): Promise<StartSessionResponse> {
    const st = await fs.stat(req.inputPath).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, "inputPath does not exist or is not a file");

    let probe: ProbeResult;
    try {
      probe = await probeFile(req.inputPath);
    } catch (e) {
      throw new HttpError(422, `ffprobe failed: ${(e as Error).message.split("\n")[0]}`);
    }
    const video = firstVideo(probe);
    if (!video || !video.width || !video.height) throw new HttpError(422, "input has no video stream");
    if (!(probe.durationSec > 0)) throw new HttpError(422, "input duration is unknown");
    let audio = firstAudio(probe);
    if (req.audioStreamIndex !== undefined) {
      audio = probe.streams.find((s) => s.index === req.audioStreamIndex && s.type === "audio");
      if (!audio) throw new HttpError(400, `stream ${req.audioStreamIndex} is not an audio stream`);
    }

    const fps = video.fps && video.fps > 0 && video.fps < 300 ? video.fps : 30;
    const renditions = resolveLadder(req.ladder, video.width, video.height, fps, !!audio);
    const color: ColorHandling = video.hdr ? (this.caps.toneMapping ? "tonemap" : "to8bit") : (video.bitDepth ?? 8) > 8 || video.pixFmt !== "yuv420p" ? "to8bit" : "sdr";
    const dir = this.sessionDir(req.sessionId);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ sessionId: req.sessionId, inputPath: req.inputPath, createdAt: Date.now() }));
    const variants: Variant[] = [];
    for (const r of renditions) {
      const vdir = path.join(dir, variantDirName(r.height));
      await fs.mkdir(vdir, { recursive: true });
      variants.push({ r, dir: vdir, lastRequested: -1, lock: Promise.resolve() });
    }
    const now = Date.now();
    const s: Session = {
      id: req.sessionId,
      req,
      dir,
      probe,
      videoIndex: video.index,
      audioIndex: audio?.index,
      fps,
      color,
      layout: segmentLayout(probe.durationSec),
      variants,
      encoder: pickEncoder(req.hwaccel, this.caps.hwaccels),
      startedAt: now,
      lastAccessAt: now,
      producedAny: false,
      deleted: false,
    };
    this.sessions.set(s.id, s);
    console.log(
      `[worker] session ${s.id}: ${req.inputPath} ${video.codec} ${video.width}x${video.height}@${fps} ${color} -> ` +
        `${renditions.map((r) => r.height + "p").join("/")} via ${s.encoder}, ${s.layout.total} segments`,
    );

    // Warm up the first rendition where playback is expected to start.
    const startSeg = Math.min(s.layout.total - 1, Math.floor((req.startPosition ?? 0) / SEGMENT_SECONDS));
    variants[0].lastRequested = startSeg;
    void this.withLock(variants[0], () => this.startRun(s, variants[0], startSeg));
    return this.response(s, false);
  }

  private response(s: Session, reused: boolean): StartSessionResponse {
    return {
      sessionId: s.id,
      duration: s.probe.durationSec,
      variants: s.variants.map((v) => this.publicVariant(v)),
      masterPath: `/hls/${s.id}/master.m3u8`,
      reused,
    };
  }

  private publicVariant(v: Variant) {
    return { height: v.r.height, width: v.r.width, bandwidth: v.r.bandwidth, videoMode: v.r.videoMode };
  }

  // ---------------- status ----------------

  private state(s: Session): SessionState {
    if (s.error) return "error";
    const runs = s.variants.map((v) => v.run).filter((r): r is FfmpegRun => !!r);
    if (!s.producedAny && (runs.length === 0 || runs.some((r) => r.alive))) return "starting";
    if (runs.some((r) => r.state === "running" || r.state === "starting")) return "running";
    return "idle";
  }

  status(s: Session): SessionStatus {
    let ready = 0;
    try {
      ready = readdirSync(s.variants[0].dir).filter((f) => /^seg_\d+\.ts$/.test(f)).length;
    } catch {
      /* dir gone */
    }
    const active = s.variants.map((v) => v.run).find((r) => r?.state === "running") ?? s.variants.map((v) => v.run).find((r) => r?.alive);
    return {
      sessionId: s.id,
      inputPath: s.req.inputPath,
      state: this.state(s),
      error: s.error,
      startedAt: s.startedAt,
      lastAccessAt: s.lastAccessAt,
      duration: s.probe.durationSec,
      variants: s.variants.map((v) => this.publicVariant(v)),
      segmentsReady: ready,
      segmentsTotal: s.layout.total,
      speed: active?.speed,
      fps: active?.fps,
      hwaccel: s.encoder,
    };
  }

  list(): SessionStatus[] {
    return [...this.sessions.values()].map((s) => this.status(s));
  }

  get(id: string): SessionStatus {
    return this.status(this.require(id));
  }

  // ---------------- delete / shutdown ----------------

  async remove(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.deleted = true;
    this.sessions.delete(id);
    await Promise.all(s.variants.map((v) => v.run?.kill()));
    await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    console.log(`[worker] session ${id} removed`);
    return true;
  }

  /** Last-resort synchronous cleanup (process 'exit' handler): SIGKILL every ffmpeg child. */
  killAllSync() {
    for (const s of this.sessions.values()) for (const v of s.variants) void v.run?.kill();
  }

  async shutdown() {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id)));
  }

  // ---------------- playlists ----------------

  master(id: string): string {
    const s = this.require(id);
    return masterPlaylist(
      s.variants.map((v) => this.publicVariant(v)),
      s.fps,
      s.audioIndex !== undefined,
    );
  }

  variantPlaylist(id: string, height: number): string {
    const s = this.require(id);
    if (!s.variants.some((v) => v.r.height === height)) throw new HttpError(404, "no such variant");
    return variantPlaylist(s.layout);
  }

  // ---------------- segments ----------------

  /** Resolve to the absolute path of a complete segment file, producing it on demand. */
  async segment(id: string, height: number, n: number, signal?: AbortSignal): Promise<string> {
    const s = this.require(id);
    const v = s.variants.find((x) => x.r.height === height);
    if (!v) throw new HttpError(404, "no such variant");
    if (!Number.isInteger(n) || n < 0 || n >= s.layout.total) throw new HttpError(404, "segment out of range");
    v.lastRequested = n;
    const file = path.join(v.dir, segmentName(n));
    if (existsSync(file)) {
      this.throttle(v);
      return file;
    }
    await this.withLock(v, () => this.ensureProducing(s, v, n));
    return this.waitFor(s, v, n, file, signal);
  }

  private withLock<T>(v: Variant, fn: () => Promise<T>): Promise<T> {
    const p = v.lock.then(fn, fn);
    v.lock = p.catch(() => {});
    return p;
  }

  /** Make sure some ffmpeg run will produce segment n soon; restart at n otherwise. */
  private async ensureProducing(s: Session, v: Variant, n: number) {
    if (s.deleted || existsSync(path.join(v.dir, segmentName(n)))) return;
    const run = v.run;
    if (run?.alive && n >= run.start && n <= run.writing + LOOKAHEAD_SEGMENTS) {
      run.resume();
      return;
    }
    await this.startRun(s, v, n);
  }

  private async startRun(s: Session, v: Variant, start: number) {
    if (v.run) await v.run.kill();
    if (s.deleted) return;
    // Drop partial files of the killed run (complete segments are kept) and remember which segments
    // already exist: a run reaching one of those is overlapping earlier work and skips ahead.
    const preexisting = new Set<number>();
    for (const f of await fs.readdir(v.dir).catch(() => [] as string[])) {
      if (f.endsWith(".tmp")) await fs.rm(path.join(v.dir, f), { force: true });
      const m = /^seg_(\d+)\.ts$/.exec(f);
      if (m) preexisting.add(Number(m[1]));
    }
    const run = new FfmpegRun({
      inputPath: s.req.inputPath,
      videoIndex: s.videoIndex,
      audioIndex: s.audioIndex,
      height: v.r.height,
      videoKbps: v.r.videoKbps,
      fps: s.fps,
      startSegment: start,
      totalSegments: s.layout.total,
      outDir: v.dir,
      encoder: s.encoder,
      vaapiDevice: this.cfg.vaapiDevice,
      color: s.color,
    });
    v.run = run;
    run.on("segment", () => this.onSegment(s, v, run, preexisting));
    run.on("exit", (state) => {
      if (state === "error" && v.run === run && !s.deleted) {
        s.error = run.error ?? "ffmpeg failed";
        console.error(`[worker] session ${s.id} v${v.r.height}: ffmpeg failed at segment ${run.writing}: ${s.error}`);
      }
    });
  }

  private onSegment(s: Session, v: Variant, run: FfmpegRun, preexisting: Set<number>) {
    if (v.run !== run || s.deleted) return;
    s.producedAny = true;
    s.error = undefined;
    if (!run.alive || run.writing >= s.layout.total) return;
    // The run has started a segment an earlier run already produced: skip to the next gap.
    // (Checked against the snapshot taken at spawn time, not the disk: a fast encoder may already have
    // finished the segment it just opened by the time its log line is processed.)
    if (preexisting.has(run.writing)) {
      let m = run.writing;
      while (m < s.layout.total && (preexisting.has(m) || existsSync(path.join(v.dir, segmentName(m))))) m++;
      void this.withLock(v, async () => {
        if (v.run !== run || s.deleted) return;
        if (m < s.layout.total && m - v.lastRequested <= MAX_AHEAD_SEGMENTS) await this.startRun(s, v, m);
        else await run.kill();
      });
      return;
    }
    this.throttle(v);
  }

  /** Pause the encoder when it is far ahead of the player, resume it when the player catches up. */
  private throttle(v: Variant) {
    const run = v.run;
    if (!run?.alive) return;
    const ahead = run.writing - v.lastRequested;
    if (ahead > MAX_AHEAD_SEGMENTS) run.pause();
    else run.resume();
  }

  private async waitFor(s: Session, v: Variant, n: number, file: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new HttpError(499, "client closed request");
      if (s.deleted) throw new HttpError(410, "session was deleted");
      if (existsSync(file)) {
        this.throttle(v);
        return file;
      }
      s.lastAccessAt = Date.now();
      const run = v.run;
      if (!run?.alive) {
        if (run && n >= run.start && n < run.writing + 1) {
          if (run.state === "error") throw new HttpError(502, `ffmpeg failed: ${run.error ?? "unknown error"}`);
          if (run.state === "done") throw new HttpError(404, "segment was not produced (end of stream)");
        }
        // Killed (seek elsewhere / skip-ahead) or never started: decide again.
        await this.withLock(v, () => this.ensureProducing(s, v, n));
      } else if (n >= run.start && n <= run.writing + LOOKAHEAD_SEGMENTS) {
        run.resume();
      }
      await sleep(POLL_MS);
    }
    throw new HttpError(504, "timed out waiting for segment");
  }
}
