// Shapes returned by /api/music/* (client-side mirror of the server DTOs).
export interface TrackDTO {
  id: string; title: string; artist: string; album: string | null; albumKey: string; durationSec: number; coverUrl: string | null;
  genre: string | null; year: number | null; trackNo: number | null; codec: string | null; local: true;
}
export interface AlbumDTO { albumKey: string; album: string; artist: string; year: number | null; tracks: number; coverUrl: string | null }
export interface ArtistDTO { artist: string; tracks: number; coverUrl: string | null }
export interface Candidate {
  engine: "ytdlp" | "lavalink"; sourceId: string; title: string; artist: string; durationSec: number; url: string; score: number; license?: string; artworkUrl?: string; sourceName?: string;
}
export type RepeatMode = "off" | "all" | "one";
export interface QueueItem {
  id: string; trackId: string | null; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; origin: string; local: boolean; candidate: Candidate | null;
}
export interface QueueState { currentItemId: string | null; shuffle: boolean; repeat: RepeatMode; autoplay: boolean; positionSec: number }
export interface Queue { items: QueueItem[]; state: QueueState }
export interface EntryStatus {
  key: string; state: "queued" | "resolving" | "downloading" | "ready" | "failed"; progress: number; bytes: number; durationSec?: number; error?: string; streamable: boolean; mime: string;
  candidate?: { sourceId: string; title: string; artist: string; durationSec: number; score: number; engine: string; sourceName?: string };
}
export interface PlayInfo { item: QueueItem; kind: "local" | "ondemand"; url: string; transcode: boolean; durationSec: number | null; key?: string; status?: EntryStatus }
export interface MusicMode { source: "local" | "ondemand" | "hybrid"; local: boolean; onDemand: boolean; onDemandReason?: string }

/** What can be queued: a library track by id, or an external reference (optionally a pinned on-demand result). */
export type ItemInput = { trackId: string } | { title: string; artist: string; album?: string | null; durationSec?: number | null; artworkUrl?: string | null; candidate?: Candidate | null };

export const trackInput = (t: Pick<TrackDTO, "id">): ItemInput => ({ trackId: t.id });
export const fmtTime = (s: number | null | undefined) => {
  if (!s || !Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
