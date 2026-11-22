// Contract between the web app (src/server/music/) and the worker's music module (worker/music/).
// Same auth as the transcoding API: `Authorization: Bearer ${WORKER_TOKEN}`. All endpoints live under /music.

export type MusicEngineId = "ytdlp" | "lavalink";
export type AudioFormat = "mp3" | "aac" | "opus";
export type LicensePolicy = "licensed-only" | "attested";

export interface LavalinkNodeConfig {
  id: string;
  name: string;
  /** e.g. http://lavalink:2333 or https://node.example.com */
  url: string;
  password: string;
  /** Lavalink search prefix on this node, e.g. "scsearch" or "ytsearch" (plugins add more). */
  searchPrefix: string;
}

/** Everything the worker needs; sent with every request so the worker keeps no settings of its own. */
export interface MusicConfig {
  engine: MusicEngineId;
  /** Empty = the worker's default (MUSIC_CACHE_DIR or <TRANSCODE_DIR>/music-cache). */
  cacheDir: string;
  maxCacheMB: number;
  /** Delete cached audio once nobody needs it any more. */
  cleanup: boolean;
  cleanupGraceSec: number;
  format: AudioFormat;
  bitrateKbps: number;
  /** Simultaneous downloads/captures. */
  maxDownloads: number;
  /** Simultaneous listeners that may use on-demand audio (distinct holders with the "current" role). 0 = unlimited. */
  maxStreams: number;
  licensePolicy: LicensePolicy;
  ytdlp: { providers: ("youtube" | "soundcloud")[]; binary: string };
  lavalink: {
    nodes: LavalinkNodeConfig[];
    /** Lavalink `sourceName`s whose tracks may be played (e.g. http, soundcloud, bandcamp). */
    allowedSources: string[];
  };
}

export interface TrackQuery {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** Accept remixes / live / covers etc. instead of penalising them. */
  allowVariants?: boolean;
}

export interface Candidate {
  engine: MusicEngineId;
  /** Stable id unique per source item, e.g. "youtube:dQw4w9WgXcQ" or "lavalink:<identifier>". */
  sourceId: string;
  title: string;
  artist: string;
  durationSec: number;
  url: string;
  score: number;
  license?: string;
  artworkUrl?: string;
  /** Lavalink: base64 track blob + the node that produced it. */
  encoded?: string;
  nodeId?: string;
  sourceName?: string;
}

export type EntryState = "queued" | "resolving" | "downloading" | "ready" | "failed";
export type HoldRole = "current" | "preload";

export interface EntryStatus {
  key: string;
  state: EntryState;
  /** 0..1 of the expected duration captured so far (best effort). */
  progress: number;
  bytes: number;
  durationSec?: number;
  error?: string;
  candidate?: Pick<Candidate, "sourceId" | "title" | "artist" | "durationSec" | "score" | "engine" | "sourceName">;
  holders: number;
  mime: string;
  /** True while the audio can be read from the start without waiting for the full download. */
  streamable: boolean;
}

export interface PrepareRequest {
  cfg: MusicConfig;
  /** Either a query to resolve, or a pinned candidate (user picked a search result). */
  query?: TrackQuery;
  candidate?: Candidate;
  /** Who needs it: usually a profile id. */
  holder: string;
  role: HoldRole;
  /** Hold lifetime without a ping, seconds. Default 90. */
  ttlSec?: number;
}

export interface ReleaseRequest {
  holder: string;
  /** Limit to one role; omit to release everything the holder has. */
  role?: HoldRole;
  /** With `role`: keys to keep. */
  keep?: string[];
  /** Release one specific key only. */
  key?: string;
}

export interface MusicStats {
  engine: MusicEngineId | null;
  cacheDir: string;
  cacheBytes: number;
  maxCacheBytes: number;
  entries: number;
  jobsRunning: number;
  jobsQueued: number;
  listeners: number;
  /** What the cache holds right now (for the admin page). */
  tracks: { key: string; title: string; artist: string; state: EntryState; bytes: number; roles: HoldRole[]; sourceId?: string }[];
  ytdlp: { available: boolean; version?: string };
  lavalink: { nodes: { id: string; name: string; online: boolean; players?: number; version?: string; error?: string }[]; sinkReady: boolean; sinkEndpoint?: string };
}

export const AUDIO_MIME: Record<AudioFormat, string> = { mp3: "audio/mpeg", aac: "audio/aac", opus: "audio/ogg" };
