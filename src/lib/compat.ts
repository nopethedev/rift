// Client-side playback decision: direct play vs. in-browser Mediabunny remux/transcode vs. server HLS.
import type { PlayerInfo } from "./types";

export type PlayMode = "direct" | "mediabunny" | "hls";

export interface Decision {
  mode: PlayMode;
  reason: string;
  /** Mediabunny: DD / DD+ audio is decoded in the browser and re-encoded to AAC or Opus. */
  audioTranscode: boolean;
}

const MSE_VIDEO: Record<string, string[]> = {
  h264: ["avc1.640028", "avc1.4d401f"],
  hevc: ["hvc1.1.6.L120.90", "hev1.1.6.L120.90"],
  vp9: ["vp09.00.10.08"],
  av1: ["av01.0.08M.08"],
  vp8: ["vp8"],
};
const MSE_VIDEO_10BIT: Record<string, string[]> = { hevc: ["hvc1.2.4.L120.90"], vp9: ["vp09.02.10.10"], av1: ["av01.0.08M.10"] };

/** Codecs a plain <video src> / MSE can decode without help. */
const NATIVE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** Dolby Digital / Digital Plus: always decoded by Mediabunny in the browser. */
export const DOLBY_AUDIO = new Set(["eac3", "ac3"]);

export const hasMse = () => typeof window !== "undefined" && typeof (window as any).MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";

export function videoSupported(codec: string, bitDepth?: number): boolean {
  if (!hasMse()) return false;
  if (codec === "h264" && bitDepth && bitDepth > 8) return false; // High10: effectively unsupported in browsers
  const list = (bitDepth && bitDepth > 8 ? MSE_VIDEO_10BIT[codec] : MSE_VIDEO[codec]) ?? [];
  return list.some((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`) || MediaSource.isTypeSupported(`video/webm; codecs="${c}"`));
}

/** Container that a plain <video> can play progressively (range requests) with the audio we have. */
function containerNativelyPlayable(container: string, vcodec: string): boolean {
  const v = document.createElement("video");
  if (container.includes("mp4") || container.includes("mov")) return vcodec === "h264" || vcodec === "hevc" || vcodec === "av1" || vcodec === "vp9" ? v.canPlayType("video/mp4") !== "" : false;
  if (container.includes("webm") && !container.includes("matroska,webm")) return true;
  return false; // mkv, avi, ts, ... -> remux with Mediabunny
}

export function decide(info: PlayerInfo, audioOrdinal: number, forceMode?: PlayMode): Decision {
  const v = info.video;
  if (!v) return { mode: "hls", reason: "No video stream", audioTranscode: false };
  const audio = info.audio[audioOrdinal] ?? info.audio[0];
  const acodec = audio?.codec;
  const dolby = !!acodec && DOLBY_AUDIO.has(acodec);
  const vOk = videoSupported(v.codec, v.bitDepth);
  if (forceMode === "hls") return { mode: "hls", reason: "Server transcode selected", audioTranscode: false };

  if (!vOk || !hasMse() && (dolby || audioOrdinal > 0)) {
    // Video can't be decoded by this browser (or no MSE to remux with): the server must transcode the video.
    return { mode: "hls", reason: !vOk ? `${v.codec}${v.bitDepth && v.bitDepth > 8 ? ` ${v.bitDepth}-bit` : ""} video isn't supported by this browser` : "Browser has no MediaSource support", audioTranscode: false };
  }
  const nativeAudio = !acodec || NATIVE_AUDIO.has(acodec);
  const nativeContainer = containerNativelyPlayable(info.container, v.codec);
  const defaultTrack = audioOrdinal === 0 || !info.audio.length;
  if (dolby) return { mode: "mediabunny", reason: `${acodec === "eac3" ? "Dolby Digital Plus" : "Dolby Digital"} audio converted in-browser (Mediabunny)`, audioTranscode: true };
  if (nativeContainer && nativeAudio && defaultTrack && forceMode !== "mediabunny") return { mode: "direct", reason: "Direct play", audioTranscode: false };
  if (hasMse()) return { mode: "mediabunny", reason: nativeContainer ? "Alternate audio track" : `${info.container.split(",")[0]} remuxed in-browser (Mediabunny)`, audioTranscode: !nativeAudio };
  return { mode: "hls", reason: "Format not playable directly", audioTranscode: false };
}

/** Pick the audio codec Mediabunny should encode to: AAC where the browser can encode+play it, otherwise Opus (e.g. Chromium builds without the AAC encoder). */
export async function pickAudioEncoder(preferOpus: boolean): Promise<"aac" | "opus"> {
  const { canEncodeAudio } = await import("mediabunny");
  const order: ("aac" | "opus")[] = preferOpus ? ["opus", "aac"] : ["aac", "opus"];
  for (const c of order) {
    const mse = MediaSource.isTypeSupported(`audio/mp4; codecs="${c === "aac" ? "mp4a.40.2" : "opus"}"`);
    if (mse && (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false))) return c;
  }
  throw new Error("This browser can encode neither AAC nor Opus audio (WebCodecs AudioEncoder missing). Use the server transcode instead.");
}
