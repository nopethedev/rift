// Real Whisper-tiny (ONNX, CPU) end to end. Needs the optional @huggingface/transformers package and a model folder:
//   WHISPER_MODEL_DIR=/path/containing/Xenova/whisper-tiny npx vitest run worker/whisper/e2e.test.ts
// (without WHISPER_MODEL_DIR the test is skipped: the CI sandbox has no access to Hugging Face).
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WhisperJobs } from "./jobs";
import { defaultThreads, loadTransformersTranscriber, whisperInstalled } from "./transcriber";

const MODEL_DIR = process.env.WHISPER_MODEL_DIR;
const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string, media: string;

describe.skipIf(!MODEL_DIR)("real Whisper tiny", () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-whisper-e2e-"));
    media = path.join(dir, "speech.mkv");
    // 5 s of silence, the 11 s JFK clip, 4 s of silence; plus a video stream, like a real film
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=20:r=5", "-f", "lavfi", "-t", "5", "-i", "anullsrc=r=16000:cl=mono", "-i", path.join(here, "fixtures/jfk.wav"), "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=16000:cl=mono",
      "-filter_complex", "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", media]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("is installed", async () => { expect((await whisperInstalled()).installed).toBe(true); });

  it("transcribes speech with timestamps, detects English, and ignores the silence", async () => {
    const jobs = new WhisperJobs({ makeTranscriber: (model, threads) => loadTransformersTranscriber({ model, threads, cacheDir: path.join(dir, "cache"), localModelDir: MODEL_DIR }), threads: defaultThreads() });
    const t0 = Date.now();
    const start = await jobs.start({ inputPath: media, language: "auto", translate: false, model: "Xenova/whisper-tiny" });
    let st = start;
    while (!["done", "failed"].includes(st.state)) { await new Promise((r) => setTimeout(r, 100)); st = jobs.get(start.id)!; if (Date.now() - t0 > 90_000) throw new Error("timeout " + JSON.stringify(st)); }
    expect(st.error).toBeUndefined();
    expect(st.state).toBe("done");
    expect(st.language).toBe("en");
    expect(st.detected?.lang).toBe("en");
    const vtt = jobs.vtt(start.id)!;
    const text = vtt.replace(/\d\d:\d\d:\d\d\.\d{3} --> .*\n/g, "").replace(/^\d+$/gm, "").replace(/\s+/g, " ").toLowerCase();
    expect(text).toContain("ask not what your country can do for you");
    expect(text).toContain("what you can do for your country");
    // timing: the speech starts after 5 s of silence and ends by ~16 s
    const times = [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})/g)].map((m) => [+m[3] + +m[2] * 60 + +m[4] / 1000, +m[7] + +m[6] * 60 + +m[8] / 1000]);
    expect(times[0][0]).toBeGreaterThan(4.5);
    expect(times[0][0]).toBeLessThan(7.5);
    expect(times.at(-1)![1]).toBeLessThan(17.5);
    expect(vtt).not.toMatch(/amara|subtitles by|thanks for watching/i);
    console.log(`[whisper e2e] ${st.durationSec.toFixed(0)} s of audio transcribed in ${((Date.now() - t0) / 1000).toFixed(1)} s (${st.cues} cues)\n${vtt}`);
    await jobs.stop();
  }, 120_000);
});
