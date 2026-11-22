// On-demand audio cache. One Job per source recording (shared by everyone who wants it), one Entry per requested track.
//
//   prepare() -> resolve query to candidates -> Job: engine audio -> ffmpeg -> growing file ("live tail") -> final file
//   readers can stream the file while it is still being written; once complete it is served with full Range support.
//   Holders (a listener's "current" song, queued "preload" songs) keep a job alive; unheld jobs are cancelled or, once
//   finished, deleted after a grace period. Total size is bounded; least recently used unheld audio is evicted first.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { AUDIO_MIME, type AudioFormat, type Candidate, type EntryState, type EntryStatus, type HoldRole, type MusicConfig, type PrepareRequest, type ReleaseRequest, type TrackQuery } from "../../shared/music-protocol";
import { normalize } from "../../shared/music-match";
import { EngineError, type Engine } from "./engines/types";

export class BusyError extends Error {}

const EXT: Record<AudioFormat, string> = { mp3: "mp3", aac: "aac", opus: "ogg" };
const FIRST_BYTE_TIMEOUT_MS = 45_000;
const STALL_TIMEOUT_MS = 60_000;
const RESOLVE_TTL_MS = 30 * 60_000;
const FAILED_RETRY_MS = 4_000;

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

interface Hold { holder: string; role: HoldRole; expires: number }

class Job extends EventEmitter {
  state: "queued" | "running" | "ready" | "failed" = "queued";
  bytes = 0;
  error?: string;
  realtime = false;
  startedAt = 0;
  lastUsed = Date.now();
  unheldSince: number | null = null;
  entries = new Set<Entry>();
  firstByte: Promise<void>;
  private resolveFirst!: () => void;
  private rejectFirst!: (e: Error) => void;
  hadFirstByte = false;
  killers: (() => void)[] = [];
  killed = false;
  constructor(public readonly ckey: string, public readonly candidate: Candidate, public readonly format: AudioFormat, public readonly bitrate: number, public readonly dir: string) {
    super();
    this.setMaxListeners(0);
    this.firstByte = new Promise<void>((res, rej) => { this.resolveFirst = res; this.rejectFirst = rej; });
    this.firstByte.catch(() => {});
  }
  get partPath() { return path.join(this.dir, `${this.ckey}.part`); }
  get finalPath() { return path.join(this.dir, `${this.ckey}.${EXT[this.format]}`); }
  get live() { return this.state === "running" ? this.partPath : this.finalPath; }
  markFirstByte() { if (!this.hadFirstByte) { this.hadFirstByte = true; this.resolveFirst(); } }
  fail(msg: string) {
    if (this.state === "failed") return;
    this.state = "failed";
    this.error = msg;
    if (!this.hadFirstByte) this.rejectFirst(new Error(msg));
    this.emit("change");
  }
  /** Highest role among the entries' live holds: 2 current, 1 preload, 0 unheld. */
  priority(now: number): number {
    let p = 0;
    for (const e of this.entries) p = Math.max(p, e.priority(now));
    return p;
  }
  kill() { this.killed = true; for (const k of this.killers) { try { k(); } catch { /* gone */ } } }
}

class Entry extends EventEmitter {
  holds = new Map<string, Hold>();
  job?: Job;
  error?: string;
  resolving = false;
  failedAt = 0;
  candidates: Candidate[] = [];
  constructor(public readonly key: string, public query?: TrackQuery, public pinned?: Candidate) { super(); this.setMaxListeners(0); }
  priority(now: number): number {
    let p = 0;
    for (const h of this.holds.values()) if (h.expires > now) p = Math.max(p, h.role === "current" ? 2 : 1);
    return p;
  }
  liveHolders(now: number) { return [...this.holds.values()].filter((h) => h.expires > now); }
  get state(): EntryState {
    if (this.error && !this.job) return "failed";
    if (!this.job) return "resolving";
    return this.job.state === "queued" ? "queued" : this.job.state === "running" ? "downloading" : this.job.state;
  }
}

export interface CacheOptions {
  engines: Record<string, Engine>;
  ffmpegPath?: string;
  /** Sweep period; tests shorten it. */
  sweepMs?: number;
  defaultDir: string;
}

export class MusicCache {
  cfg?: MusicConfig;
  private dir = "";
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = new Set<Job>();
  private resolveCache = new Map<string, { at: number; cands: Candidate[] }>();
  private resolveInflight = new Map<string, Promise<Candidate[]>>();
  private timer?: NodeJS.Timeout;
  private initDir?: string;

  constructor(private readonly o: CacheOptions) {
    this.timer = setInterval(() => void this.sweep(), o.sweepMs ?? 5000);
    this.timer.unref();
  }

  // ---------- configuration ----------
  async configure(cfg: MusicConfig): Promise<void> {
    this.cfg = cfg;
    const base = path.resolve(cfg.cacheDir || this.o.defaultDir);
    const dir = path.join(base, "rift-music");
    if (this.initDir === dir) return;
    await fs.mkdir(dir, { recursive: true });
    // Anything on disk from a previous run is unreferenced: remove it (only files we own).
    if (!this.initDir) for (const f of await fs.readdir(dir).catch(() => [] as string[])) if (/^[0-9a-f]{40}\.(part|mp3|aac|ogg)$/.test(f)) await fs.rm(path.join(dir, f), { force: true });
    this.dir = dir;
    this.initDir = dir;
  }

  // ---------- keys ----------
  static queryKey(q: TrackQuery, cfg: MusicConfig): string {
    return sha(`q|${cfg.engine}|${normalize(q.artist)}|${normalize(q.title)}|${Math.round((q.durationSec ?? 0) / 4)}|${q.allowVariants ? 1 : 0}|${cfg.format}|${cfg.bitrateKbps}`).slice(0, 24);
  }
  static candidateKey(c: Candidate, cfg: MusicConfig): string {
    return sha(`c|${c.engine}|${c.sourceId}|${cfg.format}|${cfg.bitrateKbps}`).slice(0, 24);
  }
  private jobKey(c: Candidate, cfg: MusicConfig) { return sha(`j|${c.engine}|${c.sourceId}|${cfg.format}|${cfg.bitrateKbps}`); }

  // ---------- public API ----------
  async prepare(req: PrepareRequest): Promise<EntryStatus> {
    await this.configure(req.cfg);
    const cfg = req.cfg;
    if (!req.query && !req.candidate) throw new Error("query or candidate required");
    const key = req.candidate ? MusicCache.candidateKey(req.candidate, cfg) : MusicCache.queryKey(req.query!, cfg);
    const now = Date.now();
    let entry = this.entries.get(key);

    if (req.role === "current" && cfg.maxStreams > 0) {
      const holders = new Set<string>();
      for (const e of this.entries.values()) for (const h of e.liveHolders(now)) if (h.role === "current") holders.add(h.holder);
      if (!holders.has(req.holder) && holders.size >= cfg.maxStreams) throw new BusyError(`Streaming limit reached (${cfg.maxStreams} listeners at once). Try again shortly.`);
    }

    if (!entry) {
      entry = new Entry(key, req.query, req.candidate);
      this.entries.set(key, entry);
    } else if (entry.state === "failed" && now - entry.failedAt > FAILED_RETRY_MS) {
      this.detach(entry); // retry from scratch
      entry.error = undefined;
    }
    if (req.role === "current") this.releaseWhere(req.holder, "current", (k) => k !== key);
    entry.holds.set(`${req.holder}:${req.role}`, { holder: req.holder, role: req.role, expires: now + (req.ttlSec ?? 90) * 1000 });
    if (!entry.job && !entry.resolving && !entry.error) void this.start(entry, cfg);
    else if (entry.job) { entry.job.unheldSince = null; entry.job.lastUsed = now; this.schedule(); }
    return this.status(entry);
  }

  release(req: ReleaseRequest) {
    const keep = new Set(req.keep ?? []);
    if (req.key) { const e = this.entries.get(req.key); if (e) { e.holds.delete(`${req.holder}:current`); e.holds.delete(`${req.holder}:preload`); } }
    else this.releaseWhere(req.holder, req.role, (k) => !keep.has(k));
    void this.reap();
  }

  private releaseWhere(holder: string, role: HoldRole | undefined, pred: (key: string) => boolean) {
    for (const e of this.entries.values()) {
      if (!pred(e.key)) continue;
      for (const r of role ? [role] : (["current", "preload"] as const)) e.holds.delete(`${holder}:${r}`);
    }
  }

  ping(holder: string, ttlSec = 90) {
    const exp = Date.now() + ttlSec * 1000;
    let n = 0;
    for (const e of this.entries.values()) for (const [k, h] of e.holds) if (h.holder === holder && h.expires > Date.now()) { e.holds.set(k, { ...h, expires: exp }); if (e.job) e.job.lastUsed = Date.now(); n++; }
    return n;
  }

  get(key: string): Entry | undefined { return this.entries.get(key); }

  status(e: Entry): EntryStatus {
    const j = e.job;
    const cand = j?.candidate ?? e.candidates[0];
    const dur = cand?.durationSec || e.query?.durationSec || 0;
    const expected = dur > 0 && this.cfg ? (dur * this.cfg.bitrateKbps * 1000) / 8 : 0;
    let progress = 0;
    if (j?.state === "ready") progress = 1;
    else if (j) progress = expected ? Math.min(0.99, j.bytes / expected) : 0;
    return {
      key: e.key,
      state: e.state,
      progress,
      bytes: j?.bytes ?? 0,
      durationSec: dur || undefined,
      error: e.error ?? j?.error,
      candidate: cand ? { sourceId: cand.sourceId, title: cand.title, artist: cand.artist, durationSec: cand.durationSec, score: cand.score, engine: cand.engine, sourceName: cand.sourceName } : undefined,
      holders: e.liveHolders(Date.now()).length,
      mime: AUDIO_MIME[j?.format ?? this.cfg?.format ?? "mp3"],
      streamable: !!j && (j.state === "ready" || (j.state === "running" && j.hadFirstByte)),
    };
  }

  stats() {
    const now = Date.now();
    let bytes = 0;
    for (const j of this.jobs.values()) bytes += j.bytes;
    const listeners = new Set<string>();
    for (const e of this.entries.values()) for (const h of e.liveHolders(now)) if (h.role === "current") listeners.add(h.holder);
    const tracks = [...this.entries.values()].map((e) => {
      const c = e.job?.candidate ?? e.candidates[0];
      return { key: e.key, title: c?.title ?? e.query?.title ?? "?", artist: c?.artist ?? e.query?.artist ?? "", state: e.state, bytes: e.job?.bytes ?? 0, roles: [...new Set(e.liveHolders(now).map((h) => h.role))], sourceId: c?.sourceId };
    });
    return { cacheDir: this.dir, cacheBytes: bytes, maxCacheBytes: (this.cfg?.maxCacheMB ?? 0) * 1048576, entries: this.entries.size, jobsRunning: this.running.size, jobsQueued: this.queue.length, listeners: listeners.size, tracks };
  }

  /** Delete every unheld cached track now (admin action). */
  async clear(): Promise<number> {
    let n = 0;
    const now = Date.now();
    for (const j of [...this.jobs.values()]) if (j.priority(now) === 0) { await this.dropJob(j); n++; }
    return n;
  }

  async shutdown() {
    if (this.timer) clearInterval(this.timer);
    for (const j of this.jobs.values()) j.kill();
    await Promise.all([...this.jobs.values()].map((j) => this.dropJob(j)));
  }

  // ---------- resolve + job creation ----------
  private async start(entry: Entry, cfg: MusicConfig) {
    entry.resolving = true;
    entry.error = undefined;
    try {
      const engine = this.o.engines[cfg.engine];
      if (!engine) throw new EngineError(`Unknown engine ${cfg.engine}`);
      const cands = entry.pinned ? [entry.pinned] : await this.resolveQuery(entry.query!, cfg, engine);
      entry.candidates = cands;
      let lastErr = "no candidates";
      for (const c of cands) {
        if (entry.priority(Date.now()) === 0) { entry.resolving = false; this.entries.delete(entry.key); return; } // everyone left while resolving
        const job = this.jobFor(c, cfg);
        entry.job = job;
        job.entries.add(entry);
        job.unheldSince = null;
        entry.emit("change");
        this.schedule();
        try {
          await job.firstByte;
          entry.resolving = false;
          return;
        } catch (e) {
          lastErr = (e as Error).message;
          job.entries.delete(entry);
          entry.job = undefined;
          if (job.state === "failed") this.removeJobIfOrphan(job);
        }
      }
      throw new EngineError(lastErr);
    } catch (e) {
      entry.resolving = false;
      entry.error = (e as Error).message;
      entry.failedAt = Date.now();
      entry.emit("change");
    }
  }

  /** Resolve a song to candidate recordings without downloading anything (cached, de-duplicated). */
  resolve(q: TrackQuery, cfg: MusicConfig): Promise<Candidate[]> {
    const engine = this.o.engines[cfg.engine];
    if (!engine) throw new EngineError(`Unknown engine ${cfg.engine}`);
    return this.resolveQuery(q, cfg, engine);
  }

  private async resolveQuery(q: TrackQuery, cfg: MusicConfig, engine: Engine): Promise<Candidate[]> {
    const rk = MusicCache.queryKey(q, cfg);
    const hit = this.resolveCache.get(rk);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.cands;
    let p = this.resolveInflight.get(rk);
    if (!p) {
      p = engine.resolve(q, cfg).then((cands) => { this.resolveCache.set(rk, { at: Date.now(), cands }); return cands; }).finally(() => this.resolveInflight.delete(rk));
      this.resolveInflight.set(rk, p);
    }
    return p;
  }

  private jobFor(c: Candidate, cfg: MusicConfig): Job {
    const ckey = this.jobKey(c, cfg);
    let j = this.jobs.get(ckey);
    if (j && j.state === "failed") { this.jobs.delete(ckey); j = undefined; }
    if (!j) {
      j = new Job(ckey, c, cfg.format, cfg.bitrateKbps, this.dir);
      this.jobs.set(ckey, j);
      this.queue.push(j);
    }
    return j;
  }

  private detach(e: Entry) {
    if (e.job) { e.job.entries.delete(e); this.removeJobIfOrphan(e.job); }
    e.job = undefined;
  }

  private removeJobIfOrphan(j: Job) {
    if (j.entries.size === 0 && j.state === "failed") { this.jobs.delete(j.ckey); void fs.rm(j.partPath, { force: true }); }
  }

  // ---------- scheduling ----------
  /**
   * Starts queued jobs by priority. Preloads may never take the last slot: one is always kept free for the song the
   * listener is actually waiting for (with a single slot, a preload only starts when nothing else is running).
   */
  private schedule() {
    const cfg = this.cfg;
    if (!cfg) return;
    const now = Date.now();
    const max = Math.max(1, cfg.maxDownloads);
    this.queue = this.queue.filter((j) => j.state === "queued");
    for (;;) {
      if (this.running.size >= max || !this.queue.length) return;
      this.queue.sort((a, b) => b.priority(now) - a.priority(now) || a.startedAt - b.startedAt);
      const lowRunning = [...this.running].filter((j) => j.priority(now) < 2).length;
      const idx = this.queue.findIndex((j) => {
        const p = j.priority(now);
        return p === 0 || p === 2 || (max >= 2 ? lowRunning < max - 1 : this.running.size === 0);
      });
      if (idx < 0) return;
      const j = this.queue.splice(idx, 1)[0];
      if (j.priority(now) === 0) { j.fail("cancelled"); this.dropJobSoon(j); continue; } // nobody wants it any more
      void this.runJob(j, cfg);
    }
  }

  private dropJobSoon(j: Job) { queueMicrotask(() => void this.dropJob(j)); }

  private async dropJob(j: Job) {
    j.kill();
    this.jobs.delete(j.ckey);
    this.running.delete(j);
    this.queue = this.queue.filter((x) => x !== j);
    for (const e of j.entries) { if (e.job === j) e.job = undefined; if (e.priority(Date.now()) === 0) this.entries.delete(e.key); }
    j.entries.clear();
    await Promise.all([fs.rm(j.partPath, { force: true }), fs.rm(j.finalPath, { force: true })]);
    j.emit("change");
  }

  // ---------- the pipeline ----------
  private async runJob(j: Job, cfg: MusicConfig) {
    j.state = "running";
    j.startedAt = Date.now();
    this.running.add(j);
    const finish = () => { this.running.delete(j); j.emit("change"); this.schedule(); };
    let out: WriteStream | undefined;
    try {
      const expected = j.candidate.durationSec > 0 ? (j.candidate.durationSec * cfg.bitrateKbps * 1000) / 8 : 6 * 1048576;
      if (!(await this.makeRoom(expected * 1.05, j))) throw new EngineError("The audio cache is full. Raise the cache size or wait for other tracks to finish.");
      const engine = this.o.engines[j.candidate.engine];
      const src = await engine.open(j.candidate, cfg);
      j.realtime = src.realtime;
      j.killers.push(() => src.close());
      if (j.killed) { src.close(); throw new Error("cancelled"); }

      const ff = spawn(this.o.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg", ffmpegArgs(cfg), { stdio: ["pipe", "pipe", "pipe"] });
      j.killers.push(() => ff.kill("SIGKILL"));
      let ffErr = "";
      ff.stderr.on("data", (d: Buffer) => { ffErr = (ffErr + d.toString()).slice(-500); });
      src.stream.on("error", () => {});
      ff.stdin.on("error", () => {}); // EPIPE when ffmpeg exits early
      src.stream.pipe(ff.stdin);

      out = createWriteStream(j.partPath);
      const ws = out;
      let lastData = Date.now();
      const watchdog = setInterval(() => {
        const limit = j.hadFirstByte ? STALL_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS;
        if (Date.now() - lastData > limit) { j.error = j.hadFirstByte ? "Audio source stalled" : "Timed out waiting for audio"; j.kill(); }
      }, 2000);
      watchdog.unref();
      let overflow = false;
      ff.stdout.on("data", (chunk: Buffer) => {
        lastData = Date.now();
        j.bytes += chunk.length;
        if (j.bytes > cfg.maxCacheMB * 1048576) { overflow = true; j.kill(); return; }
        ws.write(chunk, () => { j.markFirstByte(); j.emit("grow"); });
      });
      const ffDone = new Promise<number | null>((res) => ff.once("close", (code) => res(code)));
      const ffSpawnErr = new Promise<never>((_, rej) => ff.once("error", (e) => rej(new EngineError((e as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed on the worker" : e.message, "unavailable"))));
      ffSpawnErr.catch(() => {});
      const [code, upstream] = await Promise.all([Promise.race([ffDone, ffSpawnErr]), src.done.then(() => null, (e: Error) => e)]);
      clearInterval(watchdog);
      await new Promise<void>((res) => ws.end(() => res()));
      if (j.killed || overflow) throw new Error(overflow ? "Track is larger than the cache limit" : j.error ?? "cancelled");
      if (upstream) throw upstream;
      if (code !== 0) throw new EngineError(`ffmpeg failed${ffErr ? `: ${ffErr.trim().split("\n").pop()}` : ""}`);
      if (j.bytes === 0) throw new EngineError("The source produced no audio");
      await fs.rename(j.partPath, j.finalPath);
      j.state = "ready";
      j.lastUsed = Date.now();
      if (!j.hadFirstByte) j.markFirstByte();
      j.emit("grow");
      await this.makeRoom(0, j);
    } catch (e) {
      const msg = j.error && j.killed ? j.error : (e as Error).message;
      if (out) out.destroy();
      await fs.rm(j.partPath, { force: true });
      j.bytes = 0;
      if ((j.state as string) !== "failed") j.fail(msg);
      this.removeJobIfOrphan(j);
    } finally {
      finish();
    }
  }

  // ---------- bounding / cleanup ----------
  private totalBytes() { let t = 0; for (const j of this.jobs.values()) t += j.bytes; return t; }

  /** Frees at least `need` bytes under the limit by evicting least recently used audio nobody needs (preload-only audio too, when `keep` is wanted now). */
  private async makeRoom(need: number, keep: Job): Promise<boolean> {
    const limit = (this.cfg?.maxCacheMB ?? 0) * 1048576;
    if (!limit) return true;
    const now = Date.now();
    for (const tier of [0, 1]) {
      if (this.totalBytes() - keep.bytes + need + keep.bytes <= limit) return true;
      const victims = [...this.jobs.values()].filter((j) => j !== keep && j.state === "ready" && j.priority(now) === tier).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const v of victims) {
        if (this.totalBytes() + need - (keep.state === "running" ? keep.bytes : 0) <= limit) return true;
        if (tier === 1 && keep.priority(now) < 2) break; // a preload may not push out other preloads
        await this.dropJob(v);
      }
    }
    return this.totalBytes() - (keep.state === "running" ? keep.bytes : 0) + need <= limit;
  }

  /** Cancel/delete whatever nobody holds any more. */
  private async reap() {
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      for (const [k, h] of e.holds) if (h.expires <= now) e.holds.delete(k);
    }
    const cfg = this.cfg;
    for (const j of [...this.jobs.values()]) {
      if (j.priority(now) > 0) { j.unheldSince = null; continue; }
      if (j.state === "queued" || j.state === "running") { await this.dropJob(j); continue; } // cancelled preload / abandoned stream
      j.unheldSince ??= now;
      if (j.state === "failed") { await this.dropJob(j); continue; }
      const grace = (cfg?.cleanupGraceSec ?? 30) * 1000;
      if (cfg?.cleanup !== false && now - j.unheldSince >= grace) await this.dropJob(j);
    }
    // entries that lost their holders and have no job
    for (const e of [...this.entries.values()]) if (!e.job && !e.resolving && e.priority(now) === 0 && now - e.failedAt > 60_000) this.entries.delete(e.key);
    for (const [k, v] of this.resolveCache) if (now - v.at > RESOLVE_TTL_MS) this.resolveCache.delete(k);
    this.schedule();
  }

  private async sweep() {
    try { await this.reap(); if (this.cfg) await this.makeRoom(0, { bytes: 0, state: "ready" } as Job); } catch (e) { console.error("[music] sweep failed:", e); }
  }

  // ---------- reading ----------
  /** Waits until the entry has a streamable job (or failed). */
  async waitStreamable(e: Entry, timeoutMs = 60_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (e.error && !e.job) throw new EngineError(e.error);
      const j = e.job;
      if (j?.state === "failed") throw new EngineError(j.error ?? "failed");
      if (j && (j.state === "ready" || (j.state === "running" && j.hadFirstByte))) return j;
      const left = deadline - Date.now();
      if (left <= 0) throw new EngineError("Timed out preparing audio");
      await new Promise<void>((res) => {
        let t: NodeJS.Timeout;
        const done = () => { clearTimeout(t); e.off("change", done); j?.off("change", done); j?.off("grow", done); res(); };
        t = setTimeout(done, Math.min(left, 1000));
        e.once("change", done);
        j?.once("change", done);
        j?.once("grow", done);
      });
    }
  }

  /** Waits until the job has finished writing (or failed). */
  async waitReady(j: Job, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((j.state as string) !== "ready") {
      if ((j.state as string) === "failed") throw new EngineError(j.error ?? "failed");
      const left = deadline - Date.now();
      if (left <= 0) throw new EngineError("Timed out waiting for the download to finish");
      await new Promise<void>((res) => { const t = setTimeout(res, Math.min(left, 1000)); j.once("change", () => { clearTimeout(t); res(); }); });
    }
  }

  /** Streams the (possibly still growing) file from the beginning. Resolves when finished or `signal` aborts. */
  async *tail(j: Job, signal: AbortSignal): AsyncGenerator<Buffer> {
    const fh = await fs.open(j.live, "r").catch(async () => fs.open(j.finalPath, "r"));
    let pos = 0;
    try {
      for (;;) {
        if (signal.aborted) return;
        const avail = j.state === "ready" ? Number.MAX_SAFE_INTEGER : j.bytes;
        if (pos < avail) {
          const buf = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (bytesRead > 0) { pos += bytesRead; j.lastUsed = Date.now(); yield buf.subarray(0, bytesRead); continue; }
          if (j.state === "ready") return;
        }
        const st = j.state as string;
        if (st === "failed") throw new EngineError(j.error ?? "stream failed");
        if (st === "ready" && pos >= j.bytes) return;
        await new Promise<void>((res) => {
          let t: NodeJS.Timeout;
          const done = () => { clearTimeout(t); j.off("grow", done); j.off("change", done); signal.removeEventListener("abort", done); res(); };
          t = setTimeout(done, 500);
          j.once("grow", done);
          j.once("change", done);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      await fh.close().catch(() => {});
    }
  }

  openFinal(j: Job, range?: { start: number; end: number }) {
    return createReadStream(j.finalPath, range);
  }
  async finalSize(j: Job) { return (await fs.stat(j.finalPath)).size; }
}

export type { Job, Entry };

export function ffmpegArgs(cfg: Pick<MusicConfig, "format" | "bitrateKbps">, input = "pipe:0", pre: string[] = []): string[] {
  const codec =
    cfg.format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", `${cfg.bitrateKbps}k`, "-write_xing", "0", "-f", "mp3"]
    : cfg.format === "aac" ? ["-c:a", "aac", "-b:a", `${cfg.bitrateKbps}k`, "-f", "adts"]
    : ["-c:a", "libopus", "-b:a", `${cfg.bitrateKbps}k`, "-vbr", "on", "-f", "ogg"];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", ...pre, "-i", input, "-vn", "-map_metadata", "-1", "-ar", "44100", "-ac", "2", ...(cfg.format === "opus" ? ["-ar", "48000"] : []), ...codec, "pipe:1"];
}
