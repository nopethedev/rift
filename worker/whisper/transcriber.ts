// Speech-to-text backend: OpenAI Whisper (tiny by default) through transformers.js / ONNX Runtime, on the CPU.
// Loaded lazily so the worker runs (and the rest of Rift works) without it. Swappable: jobs only see `Transcriber`.
import os from "node:os";
import path from "node:path";
import type { Word } from "./cues";

export interface Transcriber {
  readonly model: string;
  /** Whether the model knows other languages than English (".en" models do not). */
  readonly multilingual: boolean;
  /** Most likely spoken language (ISO 639-1-ish code) of ~30 s of 16 kHz mono audio, with a 0..1 confidence. */
  detectLanguage(pcm: Float32Array): Promise<{ lang: string; confidence: number }>;
  /** Words with timestamps (seconds, relative to the start of `pcm`). */
  transcribe(pcm: Float32Array, o: { language: string; translate: boolean }): Promise<Word[]>;
}

export interface TranscriberOptions {
  model: string;
  threads: number;
  /** Where downloaded models are cached. */
  cacheDir: string;
  /** Directory holding pre-downloaded models (<dir>/<org>/<name>/…): used instead of the network when it has the model. */
  localModelDir?: string;
}

export const WHISPER_MODELS = ["Xenova/whisper-tiny", "Xenova/whisper-tiny.en", "Xenova/whisper-base", "Xenova/whisper-base.en", "Xenova/whisper-small", "Xenova/whisper-small.en"] as const;
export const DEFAULT_WHISPER_MODEL = "Xenova/whisper-tiny";

export class WhisperUnavailableError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
let lib: Promise<Any> | undefined;
function loadLib(): Promise<Any> {
  // A variable specifier keeps bundlers/TypeScript from requiring the (optional, large) package to be installed.
  const name = "@huggingface/transformers";
  return (lib ??= import(/* @vite-ignore */ name).catch((e: Error) => {
    lib = undefined;
    throw new WhisperUnavailableError(`Speech-to-text is not installed on the worker (${e.message.split("\n")[0]}). Run "npm install" (optional dependency @huggingface/transformers) or use the official Docker image.`);
  }));
}

export async function whisperInstalled(): Promise<{ installed: boolean; error?: string }> {
  try { await loadLib(); return { installed: true }; } catch (e) { return { installed: false, error: (e as Error).message }; }
}

export function defaultThreads(): number {
  const env = Number(process.env.WHISPER_THREADS);
  return Number.isInteger(env) && env > 0 ? env : Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
}

export async function loadTransformersTranscriber(o: TranscriberOptions): Promise<Transcriber> {
  const tf = await loadLib();
  const { pipeline, env, Tensor } = tf;
  const haveLocal = !!o.localModelDir && (await import("node:fs")).existsSync(path.join(o.localModelDir, ...o.model.split("/"), "config.json"));
  env.cacheDir = o.cacheDir;
  if (haveLocal) { env.localModelPath = o.localModelDir!.endsWith(path.sep) ? o.localModelDir : o.localModelDir + path.sep; env.allowRemoteModels = false; env.allowLocalModels = true; }
  let asr: Any;
  try {
    asr = await pipeline("automatic-speech-recognition", o.model, { dtype: "q8", device: "cpu", session_options: { intra_op_num_threads: o.threads, inter_op_num_threads: 1 } });
  } catch (e) {
    throw new WhisperUnavailableError(`Could not load the speech model "${o.model}": ${(e as Error).message.split("\n")[0]}. The worker downloads it from Hugging Face on first use (set WHISPER_MODEL_DIR to use files you downloaded yourself).`);
  }
  const multilingual = !/\.en$/.test(o.model);

  // Language ids sit right after <|startoftranscript|> (50258) in multilingual models: "<|en|>", "<|de|>", …
  const langIds: [number, string][] = [];
  if (multilingual) {
    for (let id = 50259; id < 50400; id++) {
      const m = /^<\|([a-z]{2,3})\|>$/.exec(asr.tokenizer.decode([id], { skip_special_tokens: false }));
      if (m) langIds.push([id, m[1]]);
    }
  }
  return {
    model: o.model,
    multilingual,
    async detectLanguage(pcm) {
      if (!multilingual || !langIds.length) return { lang: "en", confidence: 1 };
      const { input_features } = await asr.processor(pcm.length > 480000 ? pcm.subarray(0, 480000) : pcm);
      const out = await asr.model({ input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.from([50258n]), [1, 1]) });
      const logits = out.logits.data as Float32Array;
      let max = -Infinity;
      for (const [id] of langIds) max = Math.max(max, logits[id]);
      let sum = 0, best = "en", bestP = 0;
      for (const [id, code] of langIds) { const p = Math.exp(logits[id] - max); sum += p; if (p > bestP) { bestP = p; best = code; } }
      return { lang: best, confidence: bestP / sum };
    },
    async transcribe(pcm, { language, translate }) {
      const res = await asr(pcm, {
        return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5,
        ...(multilingual ? { language, task: translate ? "translate" : "transcribe" } : {}),
      });
      const words: Word[] = [];
      let last = 0;
      for (const c of (res.chunks ?? []) as { text: string; timestamp: [number, number | null] }[]) {
        const start = c.timestamp?.[0];
        if (typeof start !== "number") continue;
        const end = typeof c.timestamp[1] === "number" ? c.timestamp[1] : Math.min(start + 0.5, pcm.length / 16000);
        words.push({ text: c.text, start, end: Math.max(end, start) });
        last = end;
      }
      void last;
      return words;
    },
  };
}
