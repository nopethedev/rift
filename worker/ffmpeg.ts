// One ffmpeg process producing the HLS segments of one rendition, starting at a given segment index.
//
// Policy: video is ALWAYS transcoded. Stream copy cannot place keyframes, so copied segments would only
// line up with our pre-computed 6 s VOD playlist if the source GOP happened to be aligned to 6 s, and a
// restart at an arbitrary segment (-ss before -i) would snap to the previous source keyframe and break the
// "segment N covers [6N, 6N+6)" invariant that makes on-demand seeking safe. Correct seeking beats
// efficiency; the web app is expected to direct-play sources the browser can decode anyway.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { SEGMENT_SECONDS } from "./playlist";
import { encoderArgs, globalArgs, uploadFilters, type EncoderKind } from "./hwaccel";

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

/** Constant added to all output timestamps (keeps AAC priming samples non-negative, identical in every run). */
export const TS_BASE_SECONDS = 1;

export type ColorHandling = "sdr" | "to8bit" | "tonemap";

export interface RunSpec {
  inputPath: string;
  videoIndex: number;
  audioIndex?: number;
  height: number;
  videoKbps: number;
  fps: number;
  startSegment: number;
  totalSegments: number;
  /** Rendition output directory (absolute). */
  outDir: string;
  encoder: EncoderKind;
  vaapiDevice: string;
  color: ColorHandling;
}

export type RunState = "starting" | "running" | "paused" | "done" | "killed" | "error";

const STDERR_TAIL = 40;
const SEG_OPEN_RE = /Opening '([^']*?)seg_(\d+)\.ts\.tmp' for writing/;

function videoFilter(spec: RunSpec): string {
  const f: string[] = [`scale=-2:${spec.height}`];
  if (spec.color === "tonemap") {
    f.push(
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=tonemap=hable:desat=0",
      "zscale=t=bt709:m=bt709:r=tv",
    );
  }
  f.push("format=yuv420p", ...uploadFilters(spec.encoder));
  return f.join(",");
}

export function buildArgs(spec: RunSpec): { input: string[]; output: string[]; playlist: string } {
  const start = spec.startSegment;
  const startSec = start * SEGMENT_SECONDS;
  // Keyframe exactly on every segment boundary of this run, but none after the last boundary of the file
  // (the last playlist entry may be up to 6.5 s long).
  const lastRel = spec.totalSegments - 1 - start;
  const forceKf = `expr:if(lte(n_forced,${lastRel}),gte(t,n_forced*${SEGMENT_SECONDS}),0)`;
  const gop = Math.max(250, Math.ceil((spec.fps || 30) * SEGMENT_SECONDS * 2));
  const input = ["-hide_banner", "-nostdin", ...globalArgs(spec.encoder, spec.vaapiDevice), ...(start > 0 ? ["-ss", startSec.toFixed(3)] : [])];
  const output = [
    "-map", `0:${spec.videoIndex}`,
    ...(spec.audioIndex !== undefined ? ["-map", `0:${spec.audioIndex}`] : []),
    "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", videoFilter(spec),
    ...encoderArgs(spec.encoder, spec.videoKbps, gop),
    "-force_key_frames", forceKf,
    ...(spec.audioIndex !== undefined
      ? [
          "-c:a", "aac", "-b:a", "160k",
          // ITU-style downmix of any layout (5.1, 7.1, ...) to stereo; LFE dropped, centre/surround at -3 dB.
          "-af", "aresample=48000:ochl=stereo:clev=0.707:slev=0.707:lfe_mix_level=0",
        ]
      : []),
    // Same absolute timeline in every run: segment N starts at 6N + TS_BASE in every restart.
    "-output_ts_offset", (startSec + TS_BASE_SECONDS).toFixed(3),
    "-muxdelay", "0", "-muxpreload", "0",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_list_size", "0",
    "-hls_segment_type", "mpegts",
    "-start_number", String(start),
    // Segments are written as seg_N.ts.tmp and renamed when complete: a seg_N.ts on disk is always whole.
    "-hls_flags", "temp_file",
    "-hls_segment_filename", path.join(spec.outDir, "seg_%d.ts"),
    "-stats",
  ];
  return { input, output, playlist: path.join(spec.outDir, ".ffmpeg.m3u8") };
}

export interface FfmpegRunEvents {
  /** A segment of this run was completed (renamed to its final name). */
  segment: [index: number];
  /** The run ended (any reason). */
  exit: [state: RunState];
}

export class FfmpegRun extends EventEmitter<FfmpegRunEvents> {
  readonly spec: RunSpec;
  readonly start: number;
  /** Index currently being written (segments [start, writing) are complete). */
  writing: number;
  state: RunState = "starting";
  speed?: number;
  fps?: number;
  error?: string;
  readonly exited: Promise<void>;
  private proc?: ChildProcess;
  private killRequested = false;
  private stderrTail: string[] = [];
  private readonly cmd: ffmpeg.FfmpegCommand;

  constructor(spec: RunSpec) {
    super();
    this.spec = spec;
    this.start = spec.startSegment;
    this.writing = spec.startSegment;
    const { input, output, playlist } = buildArgs(spec);
    this.cmd = ffmpeg(spec.inputPath).inputOptions(input).outputOptions(output).output(playlist);

    let resolveExit!: () => void;
    this.exited = new Promise((r) => (resolveExit = r));

    this.cmd.on("start", () => {
      this.proc = (this.cmd as unknown as { ffmpegProc?: ChildProcess }).ffmpegProc;
      if (this.killRequested) this.proc?.kill("SIGKILL");
      else if (this.state === "starting") this.state = "running";
    });
    this.cmd.on("stderr", (line: string) => this.onStderr(line));
    this.cmd.on("end", () => {
      if (this.killRequested) this.state = "killed";
      else {
        this.state = "done";
        this.emit("segment", this.writing);
        this.writing = spec.totalSegments;
      }
      this.proc = undefined;
      this.emit("exit", this.state);
      resolveExit();
    });
    this.cmd.on("error", (err: Error) => {
      if (this.killRequested) this.state = "killed";
      else {
        this.state = "error";
        const tail = this.stderrTail.slice(-12).join("\n");
        this.error = `${err.message.split("\n")[0]}${tail ? `\n${tail}` : ""}`.slice(0, 4000);
      }
      this.proc = undefined;
      this.emit("exit", this.state);
      resolveExit();
    });
    this.cmd.run();
  }

  get alive(): boolean {
    return this.state === "starting" || this.state === "running" || this.state === "paused";
  }

  private onStderr(line: string) {
    const m = SEG_OPEN_RE.exec(line);
    if (m) {
      const idx = Number(m[2]);
      if (idx > this.writing) {
        const done = this.writing;
        this.writing = idx;
        this.emit("segment", done);
      }
      return;
    }
    if (line.startsWith("frame=") || line.includes(" speed=")) {
      const fps = /fps=\s*([\d.]+)/.exec(line);
      const speed = /speed=\s*([\d.]+)x/.exec(line);
      if (fps) this.fps = Number(fps[1]);
      if (speed) this.speed = Number(speed[1]);
      return;
    }
    if (line.trim() && !line.includes("Opening '")) {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
    }
  }

  pause() {
    if (this.state !== "running" || !this.proc) return;
    this.proc.kill("SIGSTOP");
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused" || !this.proc) return;
    this.proc.kill("SIGCONT");
    this.state = "running";
  }

  /** Kill immediately (SIGKILL also works on a SIGSTOPped process). Resolves once the process is gone. */
  kill(): Promise<void> {
    if (this.alive) {
      this.killRequested = true;
      this.proc?.kill("SIGKILL");
    }
    return this.exited;
  }
}
