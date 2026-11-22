// Job logic with real ffmpeg/ffprobe and a synthetic transcriber (one "word" per loud second), so block seams, silence skipping,
// start-offset ordering, language detection, cancellation, queueing and failure paths are all exercised deterministically.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WhisperJobs, type JobStatus, type WhisperRequest } from "./jobs";
import { WhisperUnavailableError, type Transcriber } from "./transcriber";
import type { Word } from "./cues";

let dir: string;
let media: string;
const loudSeconds: [number, number][] = [[5, 11], [24, 30]]; // everything else is silence; 5-11 straddles the block seam at 8 s

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-whisper-"));
  media = path.join(dir, "movie.mkv");
  // video + two audio tracks (track 0: tones at the "loud" times, silence between; track 1: constant tone)
  const gate = loudSeconds.map(([a, b]) => `between(t,${a},${b})`).join("+");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=30:r=5", "-f", "lavfi", "-i", `sine=frequency=300:duration=30,volume='if(${gate},0.4,0)':eval=frame`, "-f", "lavfi", "-i", "sine=frequency=500:duration=30", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", media]);
  if (r.status !== 0) throw new Error("fixture: " + r.stderr);
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

class Fake implements Transcriber {
  model = "fake"; multilingual = true;
  calls: { len: number; translate: boolean; language: string }[] = [];
  lang = { lang: "fr", confidence: 0.9 };
  delay = 0;
  fail = false;
  async detectLanguage() { return this.lang; }
  async transcribe(pcm: Float32Array, o: { language: string; translate: boolean }): Promise<Word[]> {
    this.calls.push({ len: pcm.length / 16000, ...o });
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    if (this.fail) throw new Error("decoder exploded");
    const out: Word[] = [];
    for (let s = 0; s < Math.floor(pcm.length / 16000); s++) {
      let e = 0; for (let i = s * 16000; i < (s + 1) * 16000; i++) e += pcm[i] * pcm[i];
      if (Math.sqrt(e / 16000) > 0.02) out.push({ text: ` w${s}`, start: s + 0.1, end: s + 0.8 });
    }
    return out;
  }
}

const req = (over: Partial<WhisperRequest> = {}): WhisperRequest => ({ inputPath: media, language: "auto", translate: false, model: "fake", ...over });
const make = (tr: Transcriber, o: Partial<ConstructorParameters<typeof WhisperJobs>[0]> = {}) => new WhisperJobs({ makeTranscriber: async () => tr, blockSec: 8, overlapSec: 2, ...o });
async function finish(jobs: WhisperJobs, id: string, ms = 30000): Promise<JobStatus> {
  const t = Date.now();
  for (;;) { const s = jobs.get(id)!; if (["done", "failed", "cancelled"].includes(s.state)) return s; if (Date.now() - t > ms) throw new Error("timeout, state " + s.state); await new Promise((r) => setTimeout(r, 40)); }
}
const startTimes = (vtt: string) => [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d{3}) -->/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000);
const wordsOf = (vtt: string) => vtt.split("\n").filter((l) => /w\d+/.test(l)).join(" ").match(/w\d+/g) ?? [];

describe("WhisperJobs", () => {
  it("transcribes every loud second exactly once across block seams, skips silent blocks, and detects the language", async () => {
    const tr = new Fake();
    const jobs = make(tr);
    const st = await finish(jobs, (await jobs.start(req())).id);
    expect(st.state).toBe("done");
    expect(st.progress).toBe(1);
    expect(st.durationSec).toBeGreaterThan(29);
    expect(st.language).toBe("fr");
    expect(st.detected?.lang).toBe("fr");
    const vtt = jobs.vtt(st.id)!;
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    // timestamps: loud seconds 5-10 and 24-29 present, silence absent
    const times = startTimes(vtt);
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect((t >= 4.9 && t < 11.5) || (t >= 23.9 && t < 30)).toBe(true);
    // no word is lost or doubled at the 8 s seam: 6 + 6 loud seconds -> 12 words (+-1 for the fade edges)
    const n = wordsOf(vtt).length;
    expect(n).toBeGreaterThanOrEqual(11);
    expect(n).toBeLessThanOrEqual(13);
    // the silent block [16,24) never reached the model (blocks 0-8, 8-16 and 24-30 did)
    expect(tr.calls.length).toBe(3);
    await jobs.stop();
  });

  it("starts at the requested position and wraps around to the beginning", async () => {
    const tr = new Fake();
    const jobs = make(tr);
    const id = (await jobs.start(req({ startSec: 24 }))).id;
    // first cue produced belongs to the tail (24..30); by the end the beginning is covered too
    let early: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const s = jobs.get(id)!;
      if (s.state === "running" && s.coveredSec > 0 && s.coveredSec < s.durationSec) { early = startTimes(jobs.vtt(id)!).map(String); if (early.length) break; }
      if (s.state === "done") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    const done = await finish(jobs, id);
    expect(done.state).toBe("done");
    const all = startTimes(jobs.vtt(id)!);
    expect(all.some((t) => t < 12)).toBe(true);
    expect(all.some((t) => t >= 24)).toBe(true);
    await jobs.stop();
  });

  it("passes translate only for a non-English language, and a fixed language skips detection", async () => {
    const fr = new Fake();
    let jobs = make(fr);
    await finish(jobs, (await jobs.start(req({ translate: true }))).id);
    expect(fr.calls.every((c) => c.translate && c.language === "fr")).toBe(true);
    const en = new Fake();
    en.lang = { lang: "en", confidence: 0.99 };
    jobs = make(en);
    await finish(jobs, (await jobs.start(req({ translate: true }))).id);
    expect(en.calls.every((c) => !c.translate && c.language === "en")).toBe(true);
    const fixed = new Fake();
    fixed.detectLanguage = async () => { throw new Error("must not be called"); };
    jobs = make(fixed);
    const st = await finish(jobs, (await jobs.start(req({ language: "de" }))).id);
    expect(st.state).toBe("done");
    expect(st.language).toBe("de");
    expect(st.detected).toBeUndefined();
  });

  it("english-only models always use English", async () => {
    const tr = new Fake();
    tr.multilingual = false;
    const jobs = make(tr);
    const st = await finish(jobs, (await jobs.start(req())).id);
    expect(st.language).toBe("en");
    expect(tr.calls.every((c) => c.language === "en" && !c.translate)).toBe(true);
  });

  it("transcribes the chosen audio stream", async () => {
    const tr = new Fake();
    const jobs = make(tr);
    // stream index 2 is the constant tone: loud everywhere, so every block is transcribed
    const st = await finish(jobs, (await jobs.start(req({ audioStreamIndex: 2, language: "en" }))).id);
    expect(st.state).toBe("done");
    expect(tr.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("de-duplicates identical requests, queues beyond the concurrency limit, and cancels", async () => {
    const tr = new Fake();
    tr.delay = 300;
    const jobs = make(tr, { maxConcurrent: 1 });
    const a = await jobs.start(req({ language: "en" }));
    const a2 = await jobs.start(req({ language: "en" }));
    expect(a2.id).toBe(a.id);
    const b = await jobs.start(req({ language: "de" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(jobs.get(b.id)!.state).toBe("queued");
    expect(jobs.get(b.id)!.queuePosition).toBe(1);
    expect(jobs.load()).toEqual({ running: 1, queued: 1 });
    expect(jobs.cancel(b.id)).toBe(true);
    expect(jobs.get(b.id)!.state).toBe("cancelled");
    expect(jobs.cancel(a.id)).toBe(true);
    expect(jobs.cancel(a.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(jobs.load().running).toBe(0);
    // a cancelled job can be started again
    const again = await jobs.start(req({ language: "en" }));
    expect(["queued", "loading", "running", "detecting"]).toContain(again.state);
    await jobs.stop();
  });

  it("reports failures clearly", async () => {
    const jobs = make(new Fake());
    await expect(jobs.start(req({ inputPath: path.join(dir, "nope.mkv") }))).rejects.toThrow(/not found on the worker/);
    const bad = new Fake(); bad.fail = true;
    const st = await finish(make(bad), (await make(bad).start(req({ language: "en" }))).id).catch(() => null);
    void st;
    const j2 = make(bad);
    const s2 = await finish(j2, (await j2.start(req({ language: "en" }))).id);
    expect(s2.state).toBe("failed");
    expect(s2.error).toMatch(/decoder exploded/);
    const j3 = new WhisperJobs({ makeTranscriber: async () => { throw new WhisperUnavailableError("model missing"); } });
    const s3 = await finish(j3, (await j3.start(req())).id);
    expect(s3.state).toBe("failed");
    expect(s3.error).toBe("model missing");
    // a file without audio
    const silentVideo = path.join(dir, "video-only.mkv");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-c:v", "libx264", "-preset", "ultrafast", silentVideo]);
    const j4 = make(new Fake());
    const s4 = await finish(j4, (await j4.start(req({ inputPath: silentVideo }))).id);
    expect(s4.state).toBe("failed");
    expect(s4.error).toMatch(/no readable audio|ffprobe|decode/i);
  });
});
