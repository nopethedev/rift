// Downloads a Whisper model (default: tiny, ~40 MB quantised) into a folder, e.g. at Docker build time, so the worker
// needs no internet access when the first subtitle is generated.   node scripts/fetch-whisper-model.mjs [model] [dir]
// Layout: <dir>/<org>/<name>/…  (set WHISPER_MODEL_DIR=<dir> on the worker to use it).
import { pipeline, env } from "@huggingface/transformers";

const model = process.argv[2] || "Xenova/whisper-tiny";
const dir = process.argv[3] || process.env.WHISPER_MODEL_DIR || "./whisper-models";
env.cacheDir = dir;
const t = Date.now();
await pipeline("automatic-speech-recognition", model, { dtype: "q8", device: "cpu" });
console.log(`[whisper] ${model} is in ${dir} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
