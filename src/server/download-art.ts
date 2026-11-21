import "server-only";
import { parseMediaFilename } from "./library/filename";
import { searchMovie, searchTv, tmdb, tmdbConfigured } from "./tmdb";

/** Backdrop (or poster) path per download, resolved once from the TMDB link or the release name. */
const cache = new Map<string, string | null>();

interface Input { id: string; name: string; tmdbId?: number | null; mediaType?: "movie" | "tv" | null }

async function resolve(d: Input): Promise<string | null> {
  if (d.tmdbId && d.mediaType) {
    const r = await tmdb<{ backdrop_path?: string | null; poster_path?: string | null }>(`/${d.mediaType}/${d.tmdbId}`);
    return r.backdrop_path ?? r.poster_path ?? null;
  }
  const p = parseMediaFilename(d.name);
  if (!p.title) return null;
  const res = p.kind === "episode" ? await searchTv(p.title, undefined) : await searchMovie(p.title, p.year);
  const hit = (res.results ?? []).find((r: any) => r.backdrop_path || r.poster_path);
  return hit ? hit.backdrop_path ?? hit.poster_path : null;
}

/** Attach `art` (TMDB image path) to each download. Failures and unknown names yield null and are cached. */
export async function withArt<T extends Input>(items: T[]): Promise<(T & { art: string | null })[]> {
  if (!(await tmdbConfigured())) return items.map((i) => ({ ...i, art: null }));
  return Promise.all(
    items.map(async (i) => {
      if (!cache.has(i.id)) {
        let art: string | null = null;
        try { art = await resolve(i); } catch { /* TMDB hiccup: retry on next poll */ return { ...i, art: null }; }
        if (cache.size > 300) cache.delete(cache.keys().next().value!);
        cache.set(i.id, art);
      }
      return { ...i, art: cache.get(i.id) ?? null };
    }),
  );
}
