// Contract between the web app (src/server/transcode.ts) and the FFmpeg worker (worker/).
// Auth: every request except GET /health carries `Authorization: Bearer ${WORKER_TOKEN}`.

export type HwAccel = "none" | "auto" | "nvenc" | "vaapi" | "qsv" | "videotoolbox";

/** POST /sessions  — idempotent per sessionId (same id => reuse running/finished session and refresh its idle timer). */
export interface StartSessionRequest {
  /** Chosen by the web app; [A-Za-z0-9_-]{1,80}. */
  sessionId: string;
  /** Absolute path readable by the worker (media volumes are mounted at identical paths). */
  inputPath: string;
  /** Absolute ffprobe stream index of the audio track to use. Default: first/default audio stream. */
  audioStreamIndex?: number;
  /** Target video heights, descending (e.g. [1080,720,480]). Worker drops entries above the source height; always keeps >=1 rendition. */
  ladder: number[];
  hwaccel: HwAccel;
}

export interface SessionVariant { height: number; width: number; bandwidth: number; videoMode: "copy" | "transcode" }

export interface StartSessionResponse {
  sessionId: string;
  duration: number;
  variants: SessionVariant[];
  /** Worker-relative path: GET /hls/:sessionId/master.m3u8 */
  masterPath: string;
  reused: boolean;
}

export type SessionState = "starting" | "running" | "idle" | "error";

/** GET /sessions/:id and items of GET /sessions */
export interface SessionStatus {
  sessionId: string;
  inputPath: string;
  state: SessionState;
  error?: string;
  startedAt: number;
  lastAccessAt: number;
  duration: number;
  variants: SessionVariant[];
  /** Highest segment index that exists on disk for the first variant, and total segments. */
  segmentsReady: number;
  segmentsTotal: number;
  speed?: number; // ffmpeg "x" realtime factor
  fps?: number;
  hwaccel: string; // what is actually used: "none", "nvenc", ...
}

export interface WorkerHealth {
  ok: true;
  ffmpeg: string;
  hwaccels: string[]; // detected usable encoders: nvenc, vaapi, qsv, videotoolbox
  activeSessions: number;
  maxSessions: number;
}

/** HLS: GET /hls/:sessionId/master.m3u8, /hls/:sessionId/v<height>/index.m3u8 (full VOD playlist, known up front), /hls/:sessionId/v<height>/seg_<n>.ts */
