// Hardware encoder detection and per-encoder argument building.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export type Accel = "nvenc" | "vaapi" | "qsv" | "videotoolbox";
export type EncoderKind = Accel | "none";

const ENCODER: Record<Accel, string> = {
  nvenc: "h264_nvenc",
  vaapi: "h264_vaapi",
  qsv: "h264_qsv",
  videotoolbox: "h264_videotoolbox",
};

/** Order used by hwaccel "auto". */
const PREFERENCE: Accel[] = ["nvenc", "qsv", "vaapi", "videotoolbox"];

export const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";

function run(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

export async function ffmpegVersion(): Promise<string> {
  const r = await run(["-hide_banner", "-version"], 5000);
  return r.stdout.split("\n")[0]?.trim() || "unknown";
}

/** Global (pre-input) options needed by an encoder. */
export function globalArgs(kind: EncoderKind, vaapiDevice: string): string[] {
  if (kind === "vaapi") return ["-vaapi_device", vaapiDevice];
  if (kind === "qsv") return ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"];
  return [];
}

/** Filters appended after software scaling/tone-mapping to feed the encoder. Input is 8-bit yuv420p. */
export function uploadFilters(kind: EncoderKind): string[] {
  if (kind === "vaapi") return ["format=nv12", "hwupload"];
  if (kind === "qsv") return ["format=nv12"];
  if (kind === "videotoolbox") return ["format=nv12"];
  return [];
}

/**
 * Encoder options. `kbps` is the max video bitrate of the rendition, `gop` a keyframe interval larger than
 * the segment length (real keyframes come from -force_key_frames; scene-cut keyframes are disabled so the
 * hls muxer only ever splits on our 6 s boundaries).
 */
export function encoderArgs(kind: EncoderKind, kbps: number, gop: number): string[] {
  const avg = Math.round(kbps * 0.8);
  const common = ["-g", String(gop), "-b:v", `${avg}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`];
  switch (kind) {
    case "none":
      // CRF with a VBV cap: constant quality, bounded peaks (fits the advertised BANDWIDTH).
      return [
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-crf", "21", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
        "-g", String(gop), "-sc_threshold", "0", "-forced-idr", "1",
      ];
    case "nvenc":
      return [
        "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-profile:v", "high", "-rc", "vbr", "-cq", "23",
        ...common, "-no-scenecut", "1", "-forced-idr", "1", "-bf", "2",
      ];
    case "vaapi":
      return ["-c:v", "h264_vaapi", "-profile:v", "high", "-rc_mode", "VBR", ...common];
    case "qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-profile:v", "high", "-look_ahead", "0", "-forced_idr", "1", ...common];
    case "videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-allow_sw", "0", "-realtime", "0", ...common];
  }
}

async function testEncoder(kind: Accel, vaapiDevice: string): Promise<boolean> {
  if (kind === "vaapi" && !existsSync(vaapiDevice)) return false;
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    ...globalArgs(kind, vaapiDevice),
    "-f", "lavfi", "-i", "testsrc=d=0.2:s=320x240:r=25",
    "-vf", ["format=yuv420p", ...uploadFilters(kind)].join(","),
    ...encoderArgs(kind, 1000, 50),
    "-f", "null", "-",
  ];
  return (await run(args, 15000)).ok;
}

/** Detect usable hardware encoders: listed by `ffmpeg -encoders` AND passing a tiny real encode. */
export async function detectHwAccels(vaapiDevice: string): Promise<Accel[]> {
  const list = await run(["-hide_banner", "-encoders"], 10000);
  const listed = PREFERENCE.filter((a) => new RegExp(`\\s${ENCODER[a]}\\s`).test(list.stdout));
  const results = await Promise.all(listed.map(async (a) => ((await testEncoder(a, vaapiDevice)) ? a : null)));
  return results.filter((a): a is Accel => a !== null);
}

/** Map a requested hwaccel to what is actually usable; unusable requests silently fall back to software. */
export function pickEncoder(requested: string, usable: Accel[]): EncoderKind {
  if (requested === "auto") return PREFERENCE.find((a) => usable.includes(a)) ?? "none";
  if ((PREFERENCE as string[]).includes(requested) && usable.includes(requested as Accel)) return requested as Accel;
  return "none";
}

/** Whether ffmpeg has the zscale + tonemap filters (needed for HDR -> SDR). */
export async function hasToneMapping(): Promise<boolean> {
  const r = await run(["-hide_banner", "-filters"], 10000);
  return /\szscale\s/.test(r.stdout) && /\stonemap\s/.test(r.stdout);
}
