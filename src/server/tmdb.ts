import "server-only";
import { env } from "./config";
import { getSettings } from "./settings";

export class TmdbError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

const cache = new Map<string, { exp: number; data: unknown }>();
const TTL = 10 * 60 * 1000;

export async function tmdb<T = any>(pathname: string, params: Record<string, string | number | undefined> = {}, ttl = TTL): Promise<T> {
  const s = await getSettings();
  const key = s.tmdbApiKey;
  if (!key) throw new TmdbError("TMDB API key is not configured", 503);
  const url = new URL(env.tmdbBase + pathname);
  url.searchParams.set("language", s.tmdbLanguage);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const bearer = key.length > 40;
  if (!bearer) url.searchParams.set("api_key", key);
  const ck = url.toString();
  const hit = cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.data as T;
  const res = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${key}`, accept: "application/json" } : { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new TmdbError(`TMDB ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status === 404 ? 404 : 502);
  const data = (await res.json()) as T;
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(ck, { exp: Date.now() + ttl, data });
  return data;
}

export const tmdbConfigured = async () => !!(await getSettings()).tmdbApiKey;

export const searchMulti = (query: string, page = 1) =>
  tmdb("/search/multi", { query, page, include_adult: "false" });
export const searchMovie = (query: string, year?: number) =>
  tmdb("/search/movie", { query, year, include_adult: "false" });
export const searchTv = (query: string, year?: number) =>
  tmdb("/search/tv", { query, first_air_date_year: year, include_adult: "false" });
export const getMovie = (id: number) => tmdb(`/movie/${id}`, { append_to_response: "videos,credits,release_dates" });
export const getTv = (id: number) => tmdb(`/tv/${id}`, { append_to_response: "videos,credits,content_ratings" });
export const getSeason = (tvId: number, season: number) => tmdb(`/tv/${tvId}/season/${season}`);
export const getRecommendations = (type: "movie" | "tv", id: number) => tmdb(`/${type}/${id}/recommendations`);

/** Pick the best YouTube trailer key from a TMDB `videos` payload. */
export function pickTrailer(videos?: { results?: { site: string; type: string; key: string; official?: boolean }[] }): string | null {
  const yt = (videos?.results ?? []).filter((v) => v.site === "YouTube");
  const best = yt.find((v) => v.type === "Trailer" && v.official) ?? yt.find((v) => v.type === "Trailer") ?? yt.find((v) => v.type === "Teaser") ?? yt[0];
  return best?.key ?? null;
}
