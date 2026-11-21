// Serializable types shared by server components and client components.

export type MediaKind = "movie" | "tv";

export interface CardItem {
  key: string;
  tmdbId: number | null;
  /** Local Title row id when the title exists in the library. */
  localId?: string | null;
  type: MediaKind;
  title: string;
  year?: number | null;
  posterPath?: string | null;
  backdropPath?: string | null;
  overview?: string | null;
  rating?: number | null;
  /** True when at least one playable file exists locally. */
  available: boolean;
  /** File to play for a movie, or the file to resume / next episode for a show. */
  playFileId?: string | null;
  progress?: { position: number; duration: number } | null;
  /** e.g. "S1:E3 · Pilot" for continue-watching rows. */
  subtitle?: string | null;
}

export const tmdbImg = (path: string | null | undefined, size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original" = "w342") =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

export const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

export const fmtBytes = (n: number) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

export const AVATAR_ICONS = ["smile", "ghost", "rocket", "cat", "bot", "crown", "flame", "gamepad", "heart", "star"] as const;
export const AVATAR_COLORS = ["violet", "rose", "amber", "emerald", "sky", "fuchsia", "orange", "teal"] as const;

export interface PlayerAudioTrack { index: number; codec: string; language?: string; title?: string; channels?: number; default?: boolean }
export interface PlayerSubtitle { id: string; label: string; language?: string; isDefault: boolean }

/** Payload from GET /api/media/:id/info used to bootstrap the player. */
export interface PlayerInfo {
  fileId: string;
  title: string;
  subtitle?: string;
  durationSec: number;
  container: string;
  video: { codec: string; width: number; height: number; hdr?: boolean; bitDepth?: number } | null;
  audio: PlayerAudioTrack[];
  subtitles: PlayerSubtitle[];
  resumeSec: number;
  next: { fileId: string; label: string } | null;
  ladder: number[];
  enforceMediabunnyAudio: boolean;
  backPath: string;
}
