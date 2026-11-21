import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { getMovie, getTv, pickTrailer, TmdbError } from "@/server/tmdb";
import { showPlayTarget } from "@/server/catalog";

/** Lightweight details for hover previews. */
export const GET = route("profile", async ({ req, profile }) => {
  const type = req.nextUrl.searchParams.get("type");
  const id = Number(req.nextUrl.searchParams.get("id"));
  if ((type !== "movie" && type !== "tv") || !Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid type or id");
  let d: any;
  try {
    d = type === "movie" ? await getMovie(id) : await getTv(id);
  } catch (e) {
    if (e instanceof TmdbError) throw new HttpError(e.status === 404 ? 404 : 503, e.message);
    throw e;
  }
  let cert: string | null = null;
  if (type === "movie") {
    const us = d.release_dates?.results?.find((r: any) => r.iso_3166_1 === "US");
    cert = us?.release_dates?.find((x: any) => x.certification)?.certification ?? null;
  } else {
    cert = d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === "US")?.rating ?? null;
  }
  const title = await db.title.findUnique({ where: { type_tmdbId: { type: type === "movie" ? "movie" : "show", tmdbId: id } } });
  let playFileId: string | null = null;
  let label: string | null = null;
  if (title) {
    if (type === "movie") playFileId = (await db.mediaFile.findFirst({ where: { titleId: title.id, status: "ready" }, select: { id: true } }))?.id ?? null;
    else {
      const t = await showPlayTarget(title.id, profile.id);
      playFileId = t?.fileId ?? null;
      label = t?.label ?? null;
    }
  }
  return {
    title: type === "movie" ? d.title : d.name,
    year: Number((type === "movie" ? d.release_date : d.first_air_date)?.slice(0, 4)) || null,
    runtime: type === "movie" ? d.runtime : d.episode_run_time?.[0] ?? null,
    seasons: type === "tv" ? d.number_of_seasons : null,
    rating: d.vote_average ?? null,
    certification: cert,
    genres: (d.genres ?? []).map((g: any) => g.name),
    overview: d.overview,
    trailerKey: pickTrailer(d.videos),
    backdropPath: d.backdrop_path,
    available: !!playFileId,
    playFileId,
    playLabel: label,
  };
});
