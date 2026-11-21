import { route, HttpError } from "@/server/api";
import { searchMovie, searchTv, getTv, TmdbError } from "@/server/tmdb";

/** TMDB lookup used by the wizard / manual matching. `?q=&type=movie|tv[&year=]` or `?tvId=` for season info. */
export const GET = route("admin", async ({ req }) => {
  const sp = req.nextUrl.searchParams;
  try {
    const tvId = Number(sp.get("tvId"));
    if (tvId) {
      const t = await getTv(tvId);
      return { seasons: (t.seasons ?? []).filter((s: any) => s.season_number > 0).map((s: any) => ({ number: s.season_number, name: s.name, episodes: s.episode_count })) };
    }
    const q = (sp.get("q") ?? "").trim();
    if (q.length < 2) throw new HttpError(400, "Enter at least 2 characters");
    const type = sp.get("type") === "tv" ? "tv" : "movie";
    const year = Number(sp.get("year")) || undefined;
    const data = type === "tv" ? await searchTv(q, year) : await searchMovie(q, year);
    return {
      results: (data.results ?? []).slice(0, 12).map((r: any) => ({
        tmdbId: r.id, type, title: type === "tv" ? r.name : r.title,
        year: Number((type === "tv" ? r.first_air_date : r.release_date)?.slice(0, 4)) || null,
        posterPath: r.poster_path ?? null, overview: r.overview ?? "",
      })),
    };
  } catch (e) {
    if (e instanceof TmdbError) throw new HttpError(e.status === 503 ? 503 : 502, e.message);
    throw e;
  }
});
