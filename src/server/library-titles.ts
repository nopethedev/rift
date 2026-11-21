import "server-only";
import { db } from "./db";
import { getMovie, getTv, getSeason } from "./tmdb";

const yearOf = (d?: string | null) => (d && d.length >= 4 ? Number(d.slice(0, 4)) || null : null);

/** Create or refresh a local movie Title from TMDB. */
export async function ensureMovieTitle(tmdbId: number) {
  const m = await getMovie(tmdbId);
  const data = {
    type: "movie", tmdbId, title: m.title, originalTitle: m.original_title ?? null, year: yearOf(m.release_date),
    overview: m.overview ?? null, posterPath: m.poster_path ?? null, backdropPath: m.backdrop_path ?? null,
    genres: JSON.stringify(m.genres ?? []), rating: m.vote_average ?? null, runtime: m.runtime ?? null,
    releaseDate: m.release_date ?? null, tagline: m.tagline ?? null,
  };
  return db.title.upsert({ where: { type_tmdbId: { type: "movie", tmdbId } }, create: data, update: data });
}

/** Create or refresh a local show Title from TMDB (seasons are created lazily with ensureSeason). */
export async function ensureShowTitle(tmdbId: number) {
  const t = await getTv(tmdbId);
  const data = {
    type: "show", tmdbId, title: t.name, originalTitle: t.original_name ?? null, year: yearOf(t.first_air_date),
    overview: t.overview ?? null, posterPath: t.poster_path ?? null, backdropPath: t.backdrop_path ?? null,
    genres: JSON.stringify(t.genres ?? []), rating: t.vote_average ?? null,
    runtime: t.episode_run_time?.[0] ?? null, releaseDate: t.first_air_date ?? null, tagline: t.tagline ?? null,
  };
  return db.title.upsert({ where: { type_tmdbId: { type: "show", tmdbId } }, create: data, update: data });
}

/** Ensure the season and *all* its episodes exist locally (metadata only). Returns the season row. */
export async function ensureSeason(titleId: string, showTmdbId: number, seasonNumber: number) {
  const s = await getSeason(showTmdbId, seasonNumber).catch(() => null);
  const season = await db.season.upsert({
    where: { titleId_number: { titleId, number: seasonNumber } },
    create: { titleId, number: seasonNumber, name: s?.name ?? `Season ${seasonNumber}`, overview: s?.overview ?? null, posterPath: s?.poster_path ?? null },
    update: s ? { name: s.name, overview: s.overview ?? null, posterPath: s.poster_path ?? null } : {},
  });
  for (const e of s?.episodes ?? []) {
    const data = { name: e.name ?? null, overview: e.overview ?? null, stillPath: e.still_path ?? null, runtime: e.runtime ?? null, airDate: e.air_date ?? null };
    await db.episode.upsert({
      where: { titleId_season_number: { titleId, season: seasonNumber, number: e.episode_number } },
      create: { titleId, seasonId: season.id, season: seasonNumber, number: e.episode_number, ...data },
      update: data,
    });
  }
  return season;
}

/** Ensure one episode exists (fetches the season when needed). */
export async function ensureEpisode(titleId: string, showTmdbId: number, seasonNumber: number, episodeNumber: number) {
  const existing = await db.episode.findUnique({ where: { titleId_season_number: { titleId, season: seasonNumber, number: episodeNumber } } });
  if (existing) return existing;
  const season = await ensureSeason(titleId, showTmdbId, seasonNumber);
  return (
    (await db.episode.findUnique({ where: { titleId_season_number: { titleId, season: seasonNumber, number: episodeNumber } } })) ??
    db.episode.create({ data: { titleId, seasonId: season.id, season: seasonNumber, number: episodeNumber, name: `Episode ${episodeNumber}` } })
  );
}
