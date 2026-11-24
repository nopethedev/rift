// Shapes returned by /api/music/* (client-side mirror of the server DTOs).
export interface TrackDTO {
  id: string; title: string; artist: string; album: string | null; albumKey: string; durationSec: number; coverUrl: string | null;
  genre: string | null; year: number | null; trackNo: number | null; codec: string | null; local: true;
}
export interface AlbumDTO { albumKey: string; album: string; artist: string; year: number | null; tracks: number; coverUrl: string | null }
export interface ArtistDTO { artist: string; tracks: number; coverUrl: string | null }
/** How one on-demand source did for a search (so the UI can say "Lavalink is down" while still showing yt-dlp results). */
export interface SourceReport { engine: "ytdlp" | "lavalink"; ok: boolean; count: number; error?: string }
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

/** Remote artwork goes through our own cache/proxy (no third-party requests from the browser); local paths pass through. */
export const artSrc = (u: string | null | undefined): string | null => (!u ? null : /^https?:\/\//i.test(u) ? `/api/music/art?u=${encodeURIComponent(u)}` : u);

// ---- online catalogue (Deezer): metadata only, never audio ----
export interface CatTrack { id: string; title: string; artist: string; artistId: string | null; album: string | null; albumId: string | null; durationSec: number; artworkUrl: string | null; explicit?: boolean }
export interface CatAlbum { id: string; title: string; artist: string; artistId: string | null; artworkUrl: string | null; year: number | null; kind: "album" | "single" | "ep" | "compilation" | null; tracks: number | null }
export interface CatArtist { id: string; name: string; pictureUrl: string | null; fans: number | null }
export interface Shelf {
  id: string; title: string; subtitle?: string; href?: string;
  tracks?: CatTrack[]; albums?: CatAlbum[]; artists?: CatArtist[];
}
export interface Feed { enabled: boolean; shelves: Shelf[]; genres: { id: string; name: string; pictureUrl: string | null }[]; error?: string }
export interface ArtistProfile {
  artist: CatArtist & { albums: number | null };
  bio: { text: string; url: string | null } | null;
  topTracks: CatTrack[];
  albums: CatAlbum[];
  /** Set when the release list couldn't be loaded (the count above may still say there are some). */
  albumsError?: string | null;
  related: CatArtist[];
}
/** Lyrics from LavaLyrics. `lines` (ms timestamps) only when time-synced; otherwise just `text`. */
export interface Lyrics { provider: string | null; source: string | null; synced: boolean; lines: { t: number; d: number | null; text: string }[]; text: string | null }
export interface LyricsResult { lyrics: Lyrics | null; reason?: string }
export const catInput = (t: CatTrack): ItemInput => ({ title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, artworkUrl: t.artworkUrl });
export const fmtCount = (n: number | null | undefined) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n));

/** One key per song per profile (client and server agree): the normalised "artist|title". */
export const songKey = (artist: string, title: string) => {
  const n = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return `${n(artist)}|${n(title)}`;
};
export interface SavedDTO {
  id: string; key: string; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; trackId: string | null;
  /** local = plays a library file; ondemand = pinned source; unmatched = will be searched when played */
  match: "local" | "ondemand" | "unmatched"; createdAt: string; track: TrackDTO | null;
}
/** Result of the manual match picker: a library track or a (server-signed) on-demand result. */
export type MatchPick = { trackId: string } | { candidate: Candidate };
