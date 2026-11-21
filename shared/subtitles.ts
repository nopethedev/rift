// Shared (web + worker): subtitle conversion to WebVTT. SRT/VTT are converted natively, ASS/SSA and embedded tracks via FFmpeg.
import ffmpeg from "fluent-ffmpeg";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";
export const SUBTITLE_EXTENSIONS = [".srt", ".vtt", ".ass", ".ssa"];

export function subtitleFormatOf(file: string): SubtitleFormat | null {
  const e = path.extname(file).toLowerCase().slice(1);
  return e === "srt" || e === "vtt" || e === "ass" || e === "ssa" ? e : null;
}

/** Decode bytes with BOM / UTF-16 detection, UTF-8 first, windows-1252 fallback. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_m, a, b) => `${a.padStart(8, "0")}.${b.padEnd(3, "0")}`)
    .replace(/^\d+\s*$(?=\n\d{2}:\d{2}:\d{2}\.)/gm, "") // numeric cue ids are optional in VTT; drop them
    .replace(/<\/?font[^>]*>/gi, "")
    .replace(/\{\\an?\d\}/g, "");
  return "WEBVTT\n\n" + body.trim() + "\n";
}

function ffmpegToVtt(input: string, out: string, streamIndex?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(input).noVideo().noAudio().outputOptions(["-map", streamIndex === undefined ? "0:s:0" : `0:${streamIndex}`, "-c:s", "webvtt"]).format("webvtt").output(out);
    cmd.on("end", () => resolve()).on("error", (e) => reject(e)).run();
  });
}

/** Convert an external subtitle file (.srt/.vtt/.ass/.ssa) to a WebVTT file at `outPath`. */
export async function convertSubtitleFileToVtt(inPath: string, outPath: string): Promise<void> {
  const fmt = subtitleFormatOf(inPath);
  if (!fmt) throw new Error(`Unsupported subtitle format: ${path.extname(inPath)}`);
  await mkdir(path.dirname(outPath), { recursive: true });
  if (fmt === "ass" || fmt === "ssa") return ffmpegToVtt(inPath, outPath);
  const text = decodeText(await readFile(inPath));
  const vtt = fmt === "vtt" ? (text.startsWith("WEBVTT") ? text : "WEBVTT\n\n" + text) : srtToVtt(text);
  await writeFile(outPath, vtt, "utf8");
}

/** Extract an embedded text subtitle stream (absolute ffprobe index) from a media file into WebVTT. */
export async function extractEmbeddedSubtitleToVtt(mediaPath: string, streamIndex: number, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await ffmpegToVtt(mediaPath, outPath, streamIndex);
}

/** Guess a language code from a sidecar filename like "Movie.en.srt" / "Movie.English.forced.srt". */
export function guessSubtitleLanguage(file: string): string | undefined {
  const parts = path.basename(file, path.extname(file)).toLowerCase().split(/[.\-_ ]+/).reverse();
  const names: Record<string, string> = { english: "en", spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt", russian: "ru", japanese: "ja", korean: "ko", chinese: "zh", dutch: "nl", polish: "pl", turkish: "tr", arabic: "ar", swedish: "sv" };
  for (const p of parts.slice(0, 3)) {
    if (names[p]) return names[p];
    if (/^[a-z]{2}$/.test(p) && Object.values(names).includes(p)) return p;
    if (/^[a-z]{3}$/.test(p) && ["eng", "spa", "fre", "fra", "ger", "deu", "ita", "por", "rus", "jpn", "kor", "chi", "zho", "dut", "nld"].includes(p)) return p;
  }
  return undefined;
}
