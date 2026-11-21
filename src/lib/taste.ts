// Taste profile: a small, explainable recommendation model. Pure (no DB / network) so it is unit tested.
//
// Every title carries TMDB genre ids. We fold them into ~14 "taste genres", then score a profile from
//   1. the genres it picked when the profile was created (a prior that fades as real history arrives),
//   2. what it watched  (completed ≫ half-watched ≫ barely started, recent ≫ old),
//   3. what it saved to My List (a deliberate signal).
// The top genres drive the "Picked for you" rows on the home page.

export interface TasteGenre {
  key: string;
  label: string;
  /** TMDB genre ids (movie and tv ids mixed) that signal this taste. Each id belongs to exactly one taste. */
  ids: number[];
  /** `with_genres` for /discover/movie and /discover/tv ("|" = any of). null = no such genre for that type. */
  movie: string | null;
  tv: string | null;
  /** Gradient used on the picker tiles when no poster is available. */
  from: string;
  to: string;
}

export const TASTE_GENRES: TasteGenre[] = [
  { key: "action", label: "Action & Adventure", ids: [28, 12, 10759], movie: "28|12", tv: "10759", from: "#ef4444", to: "#7f1d1d" },
  { key: "comedy", label: "Comedy", ids: [35], movie: "35", tv: "35", from: "#f59e0b", to: "#92400e" },
  { key: "drama", label: "Drama", ids: [18], movie: "18", tv: "18", from: "#8b5cf6", to: "#4c1d95" },
  { key: "scifi", label: "Sci-Fi & Fantasy", ids: [878, 14, 10765], movie: "878|14", tv: "10765", from: "#06b6d4", to: "#1e3a8a" },
  { key: "horror", label: "Horror", ids: [27], movie: "27", tv: null, from: "#dc2626", to: "#111827" },
  { key: "thriller", label: "Thriller", ids: [53], movie: "53", tv: null, from: "#64748b", to: "#0f172a" },
  { key: "crime", label: "Crime", ids: [80], movie: "80", tv: "80", from: "#a16207", to: "#1c1917" },
  { key: "mystery", label: "Mystery", ids: [9648], movie: "9648", tv: "9648", from: "#6366f1", to: "#1e1b4b" },
  { key: "animation", label: "Animation & Anime", ids: [16], movie: "16", tv: "16", from: "#ec4899", to: "#831843" },
  { key: "documentary", label: "Documentary", ids: [99], movie: "99", tv: "99", from: "#10b981", to: "#064e3b" },
  { key: "romance", label: "Romance", ids: [10749], movie: "10749", tv: null, from: "#f43f5e", to: "#881337" },
  { key: "family", label: "Family", ids: [10751, 10762], movie: "10751", tv: "10751|10762", from: "#38bdf8", to: "#075985" },
  { key: "war", label: "War & History", ids: [10752, 36, 10768], movie: "10752|36", tv: "10768", from: "#84cc16", to: "#365314" },
  { key: "reality", label: "Reality & Talk", ids: [10764, 10767], movie: null, tv: "10764|10767", from: "#fb923c", to: "#7c2d12" },
];

export const TASTE_KEYS = TASTE_GENRES.map((g) => g.key);
export const PICK_COUNT = 3;

const KEY_BY_ID = new Map<number, string>(TASTE_GENRES.flatMap((g) => g.ids.map((id) => [id, g.key] as const)));
export const tasteGenre = (key: string) => TASTE_GENRES.find((g) => g.key === key);
export const tasteKeyOfId = (tmdbGenreId: number) => KEY_BY_ID.get(tmdbGenreId);

/** Parse the stored JSON, keeping only known keys (max PICK_COUNT). */
export function parseFavoriteGenres(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === "string" && TASTE_KEYS.includes(k)))].slice(0, PICK_COUNT) : [];
  } catch { return []; }
}

export interface WatchSignal {
  /** TMDB genre ids of the title. */
  genres: number[];
  /** 0..1 how much of it was watched (1 for completed). */
  fraction: number;
  completed: boolean;
  /** Days since it was last watched. */
  ageDays: number;
}
export interface ListSignal { genres: number[]; ageDays: number }
export interface TasteInput { picks: string[]; watched: WatchSignal[]; saved: ListSignal[] }
export interface TasteScore { key: string; score: number }

// Weights. A pick is worth about 4 finished titles, so a handful of real watches takes over from the onboarding choice.
const PICK_WEIGHT = 4;
const COMPLETE_WEIGHT = 1.5;
const SAVED_WEIGHT = 2;
const HALF_LIFE_DAYS = 90;
const MIN_FRACTION = 0.1; // ignore accidental starts

const decay = (ageDays: number) => Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);

/** Spread a title's weight over its (≤3 distinct) taste genres so multi-genre titles don't dominate. */
function addTitle(scores: Map<string, number>, genreIds: number[], weight: number) {
  const keys = [...new Set(genreIds.map(tasteKeyOfId).filter((k): k is string => !!k))].slice(0, 3);
  for (const k of keys) scores.set(k, (scores.get(k) ?? 0) + weight / Math.sqrt(keys.length));
}

/** Genres ranked by affinity, highest first. Genres with no signal are omitted. */
export function scoreTaste(input: TasteInput): TasteScore[] {
  const scores = new Map<string, number>();
  // Earlier picks rank slightly higher, so the order they were chosen in breaks ties.
  input.picks.forEach((k, i) => { if (TASTE_KEYS.includes(k)) scores.set(k, (scores.get(k) ?? 0) + PICK_WEIGHT - i * 0.05); });
  for (const w of input.watched) {
    if (!w.completed && w.fraction < MIN_FRACTION) continue;
    addTitle(scores, w.genres, (w.completed ? COMPLETE_WEIGHT : 0.4 + w.fraction) * decay(w.ageDays));
  }
  for (const s of input.saved) addTitle(scores, s.genres, SAVED_WEIGHT * decay(s.ageDays));
  return [...scores].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score || TASTE_KEYS.indexOf(a.key) - TASTE_KEYS.indexOf(b.key));
}
