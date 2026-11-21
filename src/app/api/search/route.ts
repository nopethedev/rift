import { db } from "@/server/db";
import { route } from "@/server/api";
import { searchMulti, tmdbConfigured } from "@/server/tmdb";
import { annotateAvailability, tmdbToCard } from "@/server/catalog";
import type { CardItem } from "@/lib/types";

/** Global search: local library first, then TMDB (flagged when already local). */
export const GET = route(
  "profile",
  async ({ req }) => {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return { local: [], discover: [], tmdb: await tmdbConfigured() };
    const local = await db.title.findMany({
      where: {
        title: { contains: q },
        OR: [{ files: { some: { status: "ready" } } }, { episodes: { some: { files: { some: { status: "ready" } } } } }],
      },
      take: 24,
      orderBy: { title: "asc" },
      include: { files: { where: { status: "ready" }, take: 1, select: { id: true } } },
    });
    const localCards: CardItem[] = local.map((t) => ({
      key: `local-${t.id}`, tmdbId: t.tmdbId, localId: t.id, type: t.type === "show" ? "tv" : "movie", title: t.title, year: t.year,
      posterPath: t.posterPath, backdropPath: t.backdropPath, overview: t.overview, rating: t.rating, available: true, playFileId: t.files[0]?.id ?? null,
    }));
    let discover: CardItem[] = [];
    const configured = await tmdbConfigured();
    if (configured) {
      try {
        const data = await searchMulti(q);
        const have = new Set(localCards.map((c) => c.key.startsWith("local-") ? `${c.type}-${c.tmdbId}` : c.key));
        const cards = (data.results ?? [])
          .filter((r: any) => r.media_type === "movie" || r.media_type === "tv")
          .map((r: any) => tmdbToCard(r))
          .filter((c: CardItem | null): c is CardItem => !!c && !!c.posterPath && !have.has(c.key));
        discover = await annotateAvailability(cards);
      } catch {
        /* TMDB unavailable: local results only */
      }
    }
    return { local: localCards, discover, tmdb: configured };
  },
  { rate: { key: "search", max: 120, windowMs: 60_000 } },
);
