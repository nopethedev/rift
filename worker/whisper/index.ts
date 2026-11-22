import path from "node:path";
import type { WorkerConfig } from "../config";
import { WhisperJobs } from "./jobs";
import { defaultThreads, loadTransformersTranscriber } from "./transcriber";
import type { WhisperService } from "./routes";

/**
 * Environment:  WHISPER_MODEL_DIR   folder with pre-downloaded models (<dir>/Xenova/whisper-tiny/…): used offline when present
 *               WHISPER_CACHE_DIR   where models downloaded from Hugging Face are cached (default <TRANSCODE_DIR>/whisper-models)
 *               WHISPER_THREADS     CPU threads per job (default: up to 4)      WHISPER_CONCURRENCY  jobs at once (default 1)
 */
export function createWhisper(cfg: WorkerConfig): WhisperService {
  const cacheDir = process.env.WHISPER_CACHE_DIR || path.join(cfg.transcodeDir, "whisper-models");
  const jobs = new WhisperJobs({
    makeTranscriber: (model, threads) => loadTransformersTranscriber({ model, threads, cacheDir, localModelDir: process.env.WHISPER_MODEL_DIR || undefined }),
    maxConcurrent: Math.max(1, Number(process.env.WHISPER_CONCURRENCY) || 1),
    threads: defaultThreads(),
  });
  return { jobs, stop: () => jobs.stop() };
}
