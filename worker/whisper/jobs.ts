// Subtitle generation jobs: ffmpeg decodes the audio in blocks, the transcriber turns each block into timed words, and the
// cues grow as the job runs (so a player can show them before the whole film is done). One job per file+options, a bounded
// number of jobs at once, results kept in memory for a while after completion.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { cleanCues, toVtt, windowEnergy, wordsToCues, type Word } from "./cues";
import { WhisperUnavailableError, type Transcriber } from "./transcriber";

export interface WhisperRequest {
  inputPath: string;
  /** Absolute ffprobe stream index of the audio to transcribe; default: the first audio stream. */
  audioStreamIndex?: number;
  /** Start here first (the viewer's position), then wrap around to the beginning. */
  startSec?: number;
  /** ISO code, or "auto" to detect it. */
  language: string;
  /** Translate the speech to English (Whisper's "translate" task). */
  translate: boolean;
  model: string;
  threads?: number;
}

export type JobState = "queued" | "loading" | "detecting" | "running" | "done" | "failed" | "cancelled";
export interface JobStatus {
  id: string;
  state: JobState;
  /** 0..1 of the audio transcribed so far. */
  progress: number;
  coveredSec: number;
  durationSec: number;
  language?: string;
  detected?: { lang: string; confidence: number };
  translate: boolean;
  model: string;
  /** Bumps whenever the cues changed (clients re-download the VTT then). */
  version: number;
  cues: number;
  /** Transcription speed relative to real time. */
  speed?: number;
  queuePosition?: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface JobsOptions {
  makeTranscriber(model: string, threads: number): Promise<Transcriber>;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxConcurrent?: number;
  retentionMs?: number;
  /** Audio is transcribed in blocks of this many seconds (with a little overlap so seams do not cut words). */
  blockSec?: number;
  overlapSec?: number;
  threads?: number;
}

const SR = 16000;
const BIN = 0.5;

class Job {
  state: JobState = "queued";
  words: Word[] = [];
  covered = 0;
  durationSec = 0;
  language?: string;
  detected?: { lang: string; confidence: number };
  version = 0;
  cueCount = 0;
  error?: string;
  startedAt = Date.now();
  workStart = 0;
  finishedAt?: number;
  energy = new Float32Array(0).fill(-1);
  procs = new Set<ChildProcess>();
  cancelled = false;
  vttCache?: { version: number; text: string };
  constructor(public id: string, public req: WhisperRequest) {}
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class WhisperJobs {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private transcribers = new Map<string, Promise<Transcriber>>();
  private timer?: NodeJS.Timeout;
  private readonly o: Required<Omit<JobsOptions, "ffmpegPath" | "ffprobePath">> & Pick<JobsOptions, "ffmpegPath" | "ffprobePath">;

  constructor(o: JobsOptions) {
    this.o = { maxConcurrent: 1, retentionMs: 30 * 60_000, blockSec: 120, overlapSec: 3, threads: 4, ...o };
    this.timer = setInterval(() => this.purge(), 60_000);
    this.timer.unref();
  }

  private ffmpeg = () => this.o.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  private ffprobe = () => this.o.ffprobePath || process.env.FFPROBE_PATH || "ffprobe";

  static idFor(req: WhisperRequest, st: { size: number; mtimeMs: number }): string {
    return sha(JSON.stringify([req.inputPath, st.size, Math.floor(st.mtimeMs), req.model, req.language, req.translate, req.audioStreamIndex ?? null])).slice(0, 32);
  }

  async start(req: WhisperRequest): Promise<JobStatus> {
    const st = await fs.stat(req.inputPath).catch(() => null);
    if (!st?.isFile()) throw new Error("The media file was not found on the worker (is the media folder mounted at the same path?)");
    const id = WhisperJobs.idFor(req, st);
    const existing = this.jobs.get(id);
    if (existing && existing.state !== "failed" && existing.state !== "cancelled") return this.status(existing);
    const job = new Job(id, req);
    this.jobs.set(id, job);
    this.queue.push(job);
    queueMicrotask(() => this.pump());
    return this.status(job);
  }

  get(id: string): JobStatus | null { const j = this.jobs.get(id); return j ? this.status(j) : null; }
  list(): JobStatus[] { return [...this.jobs.values()].map((j) => this.status(j)); }
  /** Jobs waiting or working. */
  load() { return { running: this.running, queued: this.queue.length }; }

  vtt(id: string): string | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (j.vttCache?.version === j.version) return j.vttCache.text;
    const cues = cleanCues(wordsToCues(j.words), { rms: (a, b) => windowEnergy(j.energy, BIN, a, b) });
    j.cueCount = cues.length;
    j.vttCache = { version: j.version, text: toVtt(cues) };
    return j.vttCache.text;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || ["done", "failed", "cancelled"].includes(j.state)) return false;
    j.cancelled = true;
    j.state = "cancelled";
    j.finishedAt = Date.now();
    for (const p of j.procs) p.kill("SIGKILL");
    this.queue = this.queue.filter((x) => x !== j);
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const j of this.jobs.values()) this.cancel(j.id);
  }

  private status(j: Job): JobStatus {
    if (j.state === "running" || j.state === "done") this.vtt(j.id); // refresh the cue count
    const elapsed = j.workStart ? ((j.finishedAt ?? Date.now()) - j.workStart) / 1000 : 0;
    return {
      id: j.id, state: j.state, progress: j.state === "done" ? 1 : j.durationSec ? Math.min(1, j.covered / j.durationSec) : 0, coveredSec: j.covered, durationSec: j.durationSec,
      language: j.language, detected: j.detected, translate: j.req.translate, model: j.req.model, version: j.version, cues: j.cueCount,
      speed: elapsed > 3 && j.covered > 0 ? j.covered / elapsed : undefined, queuePosition: j.state === "queued" ? this.queue.indexOf(j) + 1 : undefined,
      error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt,
    };
  }

  private purge() {
    const cutoff = Date.now() - this.o.retentionMs;
    for (const [id, j] of this.jobs) if (j.finishedAt && j.finishedAt < cutoff) this.jobs.delete(id);
  }

  private pump() {
    while (this.running < this.o.maxConcurrent && this.queue.length) {
      const j = this.queue.shift()!;
      if (j.cancelled) continue;
      this.running++;
      void this.run(j).finally(() => { this.running--; this.pump(); });
    }
  }

  // ---------- the work ----------
  private async run(j: Job) {
    try {
      j.workStart = Date.now();
      j.durationSec = await this.probeDuration(j.req);
      if (!(j.durationSec > 0)) throw new Error("The file has no readable audio");
      j.energy = new Float32Array(Math.ceil(j.durationSec / BIN) + 4).fill(-1);
      j.state = "loading";
      const threads = j.req.threads ?? this.o.threads;
      const key = `${j.req.model}|${threads}`;
      let tp = this.transcribers.get(key);
      if (!tp) { tp = this.o.makeTranscriber(j.req.model, threads); this.transcribers.set(key, tp); tp.catch(() => this.transcribers.delete(key)); }
      const tr = await tp;
      if (j.cancelled) return;

      let lang = j.req.language;
      if (!tr.multilingual) lang = "en";
      else if (lang === "auto") {
        j.state = "detecting";
        const d = await this.detect(j, tr);
        if (j.cancelled) return;
        j.detected = d;
        lang = d.lang;
      }
      j.language = lang;
      const translate = j.req.translate && lang !== "en" && tr.multilingual;

      j.state = "running";
      const start = Math.min(Math.max(0, j.req.startSec ?? 0), Math.max(0, j.durationSec - 1));
      await this.transcribeRegion(j, tr, start, j.durationSec, lang, translate);
      if (start > 1) await this.transcribeRegion(j, tr, 0, start, lang, translate);
      if (j.cancelled) return;
      j.state = "done";
      j.finishedAt = Date.now();
      j.version++;
    } catch (e) {
      if (j.cancelled) return;
      j.state = "failed";
      j.error = e instanceof WhisperUnavailableError ? e.message : (e as Error).message;
      j.finishedAt = Date.now();
      j.version++;
    } finally {
      for (const p of j.procs) p.kill("SIGKILL");
    }
  }

  private probeDuration(r: WhisperRequest): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = ["-v", "error", ...(r.audioStreamIndex !== undefined ? ["-select_streams", String(r.audioStreamIndex)] : ["-select_streams", "a:0"]), "-show_entries", "stream=duration:format=duration", "-of", "csv=p=0", r.inputPath];
      const p = spawn(this.ffprobe(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.once("error", (e) => reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "ffprobe is not installed on the worker" : e.message)));
      p.once("close", (code) => {
        const nums = out.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (code !== 0 && !nums.length) return reject(new Error(`ffprobe failed: ${err.trim().split("\n").pop() || code}`));
        // stream duration may be N/A (e.g. Matroska): fall back to the container's
        resolve(nums.length ? Math.max(...nums) : 0);
      });
    });
  }

  /** ffmpeg -> 16 kHz mono s16le on stdout for [from, to). */
  private pcm(j: Job, from: number, to: number): { stream: NodeJS.ReadableStream; done: Promise<void> } {
    const r = j.req;
    const args = ["-v", "error", "-nostdin", "-ss", String(from), "-t", String(Math.max(0.1, to - from)), "-i", r.inputPath, "-map", r.audioStreamIndex !== undefined ? `0:${r.audioStreamIndex}` : "0:a:0", "-vn", "-sn", "-dn",
      // light dynamic range compression: dialogue under loud effects is what we want the model to hear
      "-af", "dynaudnorm=f=200:g=11:m=8", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"];
    const p = spawn(this.ffmpeg(), args, { stdio: ["ignore", "pipe", "pipe"] });
    j.procs.add(p);
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-400)));
    const done = new Promise<void>((resolve, reject) => {
      p.once("error", (e) => reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed on the worker" : e.message)));
      p.once("close", (code) => { j.procs.delete(p); code === 0 || j.cancelled ? resolve() : reject(new Error(`ffmpeg could not decode the audio: ${err.trim().split("\n").pop() ?? code}`)); });
    });
    done.catch(() => {});
    return { stream: p.stdout!, done };
  }

  /** Reads exactly `samples` (or fewer at the end of the stream) 16-bit samples as floats. */
  private async *blocks(stream: NodeJS.ReadableStream, samples: number): AsyncGenerator<Float32Array> {
    const want = samples * 2;
    let buf: Buffer[] = [], have = 0;
    const emit = (b: Buffer) => { const n = b.length >> 1; const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = b.readInt16LE(i * 2) / 32768; return f; };
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buf.push(chunk); have += chunk.length;
      while (have >= want) {
        const all = Buffer.concat(buf);
        yield emit(all.subarray(0, want));
        const rest = all.subarray(want);
        buf = rest.length ? [rest] : []; have = rest.length;
      }
    }
    if (have > SR / 2) yield emit(Buffer.concat(buf)); // a final partial block (ignore < 0.25 s of leftovers)
  }

  private measure(j: Job, pcm: Float32Array, t0: number) {
    const bin = SR * BIN;
    for (let b = 0; b * bin < pcm.length; b++) {
      let s = 0;
      const a = b * bin, e = Math.min(pcm.length, a + bin);
      for (let i = a; i < e; i++) s += pcm[i] * pcm[i];
      const idx = Math.round(t0 / BIN) + b;
      if (idx >= 0 && idx < j.energy.length) j.energy[idx] = Math.sqrt(s / Math.max(1, e - a));
    }
  }

  private async transcribeRegion(j: Job, tr: Transcriber, from: number, to: number, lang: string, translate: boolean) {
    const block = this.o.blockSec * SR, ov = this.o.overlapSec * SR;
    const { stream, done } = this.pcm(j, from, to);
    let tail: Float32Array = new Float32Array(0);
    let t = from; // absolute start time of the current block
    const it = this.blocks(stream, block);
    let cur = (await it.next()).value as Float32Array | undefined;
    while (cur && !j.cancelled) {
      const nxt = (await it.next()).value as Float32Array | undefined;
      this.measure(j, cur, t);
      const blockEnd = t + cur.length / SR;
      const peak = Math.max(...Array.from({ length: Math.ceil(cur.length / (SR * BIN)) }, (_, b) => j.energy[Math.round(t / BIN) + b] ?? 0));
      if (peak >= 0.002) {
        const head = nxt ? nxt.subarray(0, Math.min(ov, nxt.length)) : new Float32Array(0);
        const win = new Float32Array(tail.length + cur.length + head.length);
        win.set(tail, 0); win.set(cur, tail.length); win.set(head, tail.length + cur.length);
        const winStart = t - tail.length / SR;
        const words = await tr.transcribe(win, { language: lang, translate });
        if (j.cancelled) return;
        // Each word belongs to the block its midpoint falls in; the overlap only gives the model context at the seams.
        for (const w of words) {
          const a = winStart + w.start, b = winStart + w.end, mid = (a + b) / 2;
          if (mid >= t && (nxt ? mid < blockEnd : true)) j.words.push({ text: w.text, start: a, end: b });
        }
      }
      j.covered += cur.length / SR;
      j.version++;
      tail = cur.subarray(Math.max(0, cur.length - ov));
      t = blockEnd;
      cur = nxt;
    }
    await done;
  }

  /** Language from a few loud 30 s samples spread over the file (a majority vote weighted by confidence). */
  private async detect(j: Job, tr: Transcriber): Promise<{ lang: string; confidence: number }> {
    const dur = j.durationSec;
    const win = Math.min(30, dur);
    const marks = dur <= 45 ? [0] : [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => Math.max(0, Math.min(dur - win, dur * f - win / 2)));
    const samples: { pcm: Float32Array; rms: number }[] = [];
    for (const at of marks) {
      if (j.cancelled) break;
      const { stream, done } = this.pcm(j, at, at + win);
      const chunks: Float32Array[] = [];
      for await (const b of this.blocks(stream, win * SR)) chunks.push(b);
      await done;
      const pcm = chunks[0] ?? new Float32Array(0);
      let s = 0;
      for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
      samples.push({ pcm, rms: Math.sqrt(s / Math.max(1, pcm.length)) });
    }
    const loud = samples.filter((s) => s.rms > 0.01).sort((a, b) => b.rms - a.rms).slice(0, 3);
    if (!loud.length) return { lang: "en", confidence: 0 };
    const votes = new Map<string, number>();
    let total = 0;
    for (const s of loud) {
      const d = await tr.detectLanguage(s.pcm);
      votes.set(d.lang, (votes.get(d.lang) ?? 0) + d.confidence);
      total += d.confidence;
    }
    const [lang, score] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return { lang, confidence: total ? score / total : 0 };
  }
}
