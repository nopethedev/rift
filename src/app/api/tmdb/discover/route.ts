import { route, HttpError } from "@/server/api";
import { tmdb, TmdbError } from "@/server/tmdb";
import { annotateAvailability, tmdbToCard } from "@/server/catalog";
import type { CardItem } from "@/lib/types";

/** Browse grid data: discover by genre with paging. Kids profiles are limited to family-friendly genres/ratings. */
export const GET = route("profile", async ({ req, profile }) => {
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type") === "tv" ? "tv" : "movie";
  const page = Math.min(Math.max(Number(sp.get("page")) || 1, 1), 500);
  const sort = ["popularity.desc", "vote_average.desc", "primary_release_date.desc", "first_air_date.desc"].includes(sp.get("sort") ?? "") ? sp.get("sort")! : "popularity.desc";
  const genre = sp.get("genre");
  if (genre && !/^\d+(,\d+)*$/.test(genre)) throw new HttpError(400, "Invalid genre");
  const params: Record<string, string | number> = { page, sort_by: sort, "vote_count.gte": sort.startsWith("vote_average") ? 300 : 20, include_adult: "false" };
  if (genre) params.with_genres = genre;
  if (profile.isKids) {
    params.with_genres = type === "movie" ? "10751,16" : "10762,16";
    params.with_genres = genre && ["10751", "16", "10762"].includes(genre) ? genre : (params.with_genres as string).replace(",", "|");
    if (type === "movie") { params.certification_country = "US"; params["certification.lte"] = "PG"; }
  }
  try {
    const data = await tmdb(`/discover/${type}`, params);
    const cards = (data.results ?? []).map((r: any) => tmdbToCard(r, type)).filter((c: CardItem | null): c is CardItem => !!c && !!c.posterPath);
    return { items: await annotateAvailability(cards), page, totalPages: Math.min(data.total_pages ?? 1, 500) };
  } catch (e) {
    if (e instanceof TmdbError) throw new HttpError(e.status === 503 ? 503 : 502, e.message);
    throw e;
  }
});
