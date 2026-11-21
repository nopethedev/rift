import "server-only";
import { db } from "./db";
import { tmdb, tmdbConfigured } from "./tmdb";
import { annotateAvailability, tmdbRow } from "./catalog";
import type { CardItem } from "@/lib/types";
import { TASTE_GENRES, type TasteScore, parseFavoriteGenres, scoreTaste, tasteGenre, type ListSignal, type WatchSignal } from "@/lib/taste";

const DAY = 86_400_000;
const parseGenreIds = (raw: string | null): number[] => {
  try { return (JSON.parse(raw ?? "[]") as { id: number }[]).map((g) => g.id).filter((n) => Number.isInteger(n)); } catch { return []; }
};

export interface Taste { picks: string[]; ranked: TasteScore[]; /** type-tmdbId keys the profile already watched or saved */ seen: Set<string> }

/** Collect this profile's signals (picks, watch history, My List) and score the genres. */
export async function loadTaste(profileId: string): Promise<Taste> {
  const [profile, history, list] = await Promise.all([
    db.profile.findUnique({ where: { id: profileId }, select: { favoriteGenres: true } }),
    db.watchProgress.findMany({
      where: { profileId }, orderBy: { updatedAt: "desc" }, take: 80,
      include: { mediaFile: { select: { title: { select: { id: true, type: true, tmdbId: true, genres: true } }, episode: { select: { titleRef: { select: { id: true, type: true, tmdbId: true, genres: true } } } } } } },
    }),
    db.watchlistItem.findMany({ where: { profileId }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  const now = Date.now();
  const seen = new Set<string>();

  // Watch history: one signal per title (episodes of a show roll up), keeping the strongest.
  const byTitle = new Map<string, WatchSignal>();
  for (const h of history) {
    const t = h.mediaFile.title ?? h.mediaFile.episode?.titleRef;
    if (!t) continue;
    if (t.tmdbId) seen.add(`${t.type === "show" ? "tv" : "movie"}-${t.tmdbId}`);
    const fraction = h.completed ? 1 : h.durationSec > 0 ? Math.min(1, h.positionSec / h.durationSec) : 0;
    const sig: WatchSignal = { genres: parseGenreIds(t.genres), fraction, completed: h.completed, ageDays: (now - h.updatedAt.getTime()) / DAY };
    const prev = byTitle.get(t.id);
    if (!prev || sig.fraction > prev.fraction || (sig.completed && !prev.completed)) byTitle.set(t.id, { ...sig, ageDays: Math.min(sig.ageDays, prev?.ageDays ?? Infinity) });
  }

  // My List only stores title + poster: reuse genres from the local library, ask TMDB (cached) for the rest.
  const local = list.length
    ? await db.title.findMany({ where: { OR: list.map((l) => ({ type: l.mediaType === "tv" ? "show" : "movie", tmdbId: l.tmdbId })) }, select: { type: true, tmdbId: true, genres: true } })
    : [];
  const localGenres = new Map(local.map((t) => [`${t.type === "show" ? "tv" : "movie"}-${t.tmdbId}`, parseGenreIds(t.genres)]));
  const canAsk = await tmdbConfigured();
  const saved: ListSignal[] = (
    await Promise.all(
      list.map(async (l, i): Promise<ListSignal | null> => {
        const key = `${l.mediaType}-${l.tmdbId}`;
        seen.add(key);
        let genres = localGenres.get(key);
        if (!genres && canAsk && i < 15) {
          try { genres = ((await tmdb(`/${l.mediaType}/${l.tmdbId}`)).genres ?? []).map((g: { id: number }) => g.id); } catch { /* TMDB hiccup: skip this one */ }
        }
        return genres?.length ? { genres, ageDays: (now - l.createdAt.getTime()) / DAY } : null;
      }),
    )
  ).filter((x): x is ListSignal => !!x);

  const picks = parseFavoriteGenres(profile?.favoriteGenres);
  return { picks, ranked: scoreTaste({ picks, watched: [...byTitle.values()], saved }), seen };
}

export interface TasteRow { title: string; items: CardItem[] }

/** Interleave lists, giving earlier (higher affinity) lists `weights[i]` slots per round. */
function blend<T>(lists: T[][], weights: number[], limit: number, keyOf: (t: T) => string): T[] {
  const out: T[] = [];
  const used = new Set<string>();
  const pos = lists.map(() => 0);
  while (out.length < limit && lists.some((l, i) => pos[i] < l.length)) {
    lists.forEach((l, i) => {
      for (let n = 0; n < weights[i]; n++) {
        while (pos[i] < l.length && used.has(keyOf(l[pos[i]]))) pos[i]++;
        if (pos[i] < l.length && out.length < limit) { used.add(keyOf(l[pos[i]])); out.push(l[pos[i]++]); }
      }
    });
  }
  return out;
}

const discover = (g: NonNullable<ReturnType<typeof tasteGenre>>, sort: "popularity.desc" | "vote_average.desc") =>
  Promise.all([
    g.movie ? tmdbRow("/discover/movie", { with_genres: g.movie, sort_by: sort, "vote_count.gte": sort === "vote_average.desc" ? 1500 : 300 }, "movie").catch(() => []) : Promise.resolve([] as CardItem[]),
    g.tv ? tmdbRow("/discover/tv", { with_genres: g.tv, sort_by: sort, "vote_count.gte": sort === "vote_average.desc" ? 400 : 100 }, "tv").catch(() => []) : Promise.resolve([] as CardItem[]),
  ]).then(([m, t]) => blend([m, t], [1, 1], 40, (c) => c.key));

/** Library titles that fit the taste, best first (works without TMDB). */
async function libraryPicks(ranked: TasteScore[], seen: Set<string>): Promise<CardItem[]> {
  const weight = new Map(ranked.map((r) => [r.key, r.score]));
  const keyOfId = new Map(TASTE_GENRES.flatMap((g) => g.ids.map((id) => [id, g.key] as const)));
  const titles = await db.title.findMany({
    where: { OR: [{ files: { some: { status: "ready" } } }, { episodes: { some: { files: { some: { status: "ready" } } } } }] },
    select: { id: true, type: true, tmdbId: true, title: true, year: true, posterPath: true, backdropPath: true, overview: true, rating: true, genres: true },
    take: 300,
  });
  return titles
    .filter((t) => !(t.tmdbId && seen.has(`${t.type === "show" ? "tv" : "movie"}-${t.tmdbId}`)))
    .map((t) => {
      const keys = new Set(parseGenreIds(t.genres).map((id) => keyOfId.get(id)).filter((k): k is string => !!k));
      return { t, score: [...keys].reduce((n, k) => n + (weight.get(k) ?? 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ t }): CardItem => ({
      key: `local-${t.id}`, tmdbId: t.tmdbId, localId: t.id, type: t.type === "show" ? "tv" : "movie", title: t.title, year: t.year,
      posterPath: t.posterPath, backdropPath: t.backdropPath, overview: t.overview, rating: t.rating, available: true,
    }));
}

/**
 * Home-page rows for a profile: a blend of its top genres, then a "top rated" row for each of the two best genres.
 * Library titles are listed first; things already watched or saved are left out.
 */
export async function tasteRows(profileId: string, profileName: string): Promise<TasteRow[]> {
  const { ranked, seen } = await loadTaste(profileId);
  if (!ranked.length) return [];
  const rows: TasteRow[] = [];
  const top = ranked.slice(0, 3).map((r) => ({ ...r, genre: tasteGenre(r.key)! })).filter((r) => r.genre);

  const lib = await libraryPicks(ranked, seen).catch(() => []);
  const usedKeys = new Set<string>();

  if (await tmdbConfigured()) {
    const lists = await Promise.all(top.map((t) => discover(t.genre, "popularity.desc")));
    const fresh = (l: CardItem[]) => l.filter((c) => !seen.has(c.key));
    const mixed = blend(lists.map(fresh), top.map((_, i) => (i === 0 ? 2 : 1)), 24, (c) => c.key);
    // Playable-now titles first, otherwise keep the blended order.
    const ordered = [...mixed.filter((c) => c.available), ...mixed.filter((c) => !c.available)];
    if (ordered.length >= 6) { rows.push({ title: `Top picks for ${profileName}`, items: ordered }); ordered.forEach((c) => usedKeys.add(c.key)); }

    for (const t of top.slice(0, 2)) {
      const best = (await discover(t.genre, "vote_average.desc")).filter((c) => !seen.has(c.key) && !usedKeys.has(c.key)).slice(0, 20);
      if (best.length >= 6) { rows.push({ title: `Because you like ${t.genre.label}`, items: best }); best.forEach((c) => usedKeys.add(c.key)); }
    }
  }
  const libItems = lib.filter((c) => !usedKeys.has(c.key));
  if (libItems.length >= 3) rows.push({ title: rows.length ? "From your library, for you" : `Picked for ${profileName}`, items: await annotateAvailability(libItems) });
  return rows;
}

/** Posters for the genre tiles in the profile picker (3 per genre, from TMDB popularity). Cached in memory. */
let samplesCache: { at: number; data: Record<string, string[]> } | null = null;
export async function genreSamples(): Promise<Record<string, string[]>> {
  if (samplesCache && Date.now() - samplesCache.at < 6 * 3600_000) return samplesCache.data;
  const data: Record<string, string[]> = {};
  if (await tmdbConfigured()) {
    await Promise.all(TASTE_GENRES.map(async (g) => {
      const type = g.movie ? "movie" : "tv";
      try {
        const r = await tmdb(`/discover/${type}`, { with_genres: type === "movie" ? g.movie! : g.tv!, sort_by: "popularity.desc", "vote_count.gte": 200 });
        data[g.key] = (r.results ?? []).map((x: { poster_path?: string | null }) => x.poster_path).filter(Boolean).slice(0, 3);
      } catch { data[g.key] = []; }
    }));
    samplesCache = { at: Date.now(), data };
  }
  return data;
}
