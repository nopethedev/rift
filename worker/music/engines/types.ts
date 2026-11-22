import type { Readable } from "node:stream";
import type { Candidate, MusicConfig, TrackQuery } from "../../../shared/music-protocol";

export interface AudioSource {
  /** Raw audio in any container ffmpeg can read from a pipe. */
  stream: Readable;
  /** True when the source only delivers audio at playback speed (Lavalink), so a full capture takes as long as the song. */
  realtime: boolean;
  /** Settles when the upstream finished: resolves on clean completion, rejects with the reason on failure. */
  done: Promise<void>;
  close(): void;
}

export class EngineError extends Error {
  constructor(message: string, public readonly code: "unavailable" | "unlicensed" | "not-found" | "failed" = "failed") {
    super(message);
  }
}

export interface Engine {
  readonly id: "ytdlp" | "lavalink";
  /** Free-text search for the UI. Results are not licence-checked yet (that happens when opening). */
  search(text: string, cfg: MusicConfig, limit: number): Promise<Candidate[]>;
  /** Best acceptable recordings for a requested song, best first. Throws EngineError when none qualifies. */
  resolve(query: TrackQuery, cfg: MusicConfig): Promise<Candidate[]>;
  /** Start retrieving audio. Enforces the licence / source policy. */
  open(c: Candidate, cfg: MusicConfig): Promise<AudioSource>;
}

/** The engines to try for a request, in order. "auto" = Lavalink (only when a node is configured), then yt-dlp. */
export function engineChain(cfg: MusicConfig, engines: Record<string, Engine>): Engine[] {
  const ids = cfg.engine === "auto" ? (cfg.lavalink.nodes.length ? ["lavalink", "ytdlp"] : ["ytdlp"]) : [cfg.engine];
  const list = ids.map((id) => engines[id]).filter((e): e is Engine => !!e);
  if (!list.length) throw new EngineError(`Unknown engine ${cfg.engine}`, "unavailable");
  return list;
}
