import "server-only";
import { db } from "./db";
import { tmdb, tmdbConfigured, getRecommendations } from "./tmdb";
import type { CardItem, MediaKind } from "@/lib/types";
import { TOP_RATED_YEARS, isRecent } from "@/lib/taste";

/** Raw TMDB list result -> CardItem (availability filled in later). */
export function tmdbToCard(r: any, forced?: MediaKind): CardItem | null {
  const type: MediaKind | undefined = forced ?? (r.media_type === "tv" ? "tv" : r.media_type === "movie" ? "movie" : r.title ? "movie" : r.name ? "tv" : undefined);
  if (!type || !r.id) return null;
  const date: string | undefined = type === "movie" ? r.release_date : r.first_air_date;
  return {
    key: `${type}-${r.id}`,
    tmdbId: r.id,
    type,
    title: type === "movie" ? r.title : r.name,
    year: date ? Number(date.slice(0, 4)) || null : null,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    overview: r.overview ?? null,
    rating: r.vote_average ?? null,
    available: false,
  };
}

/** Marks which cards exist locally with a playable file and attaches a file to play. */
export async function annotateAvailability(items: CardItem[]): Promise<CardItem[]> {
  const movies = items.filter((i) => i.type === "movie" && i.tmdbId).map((i) => i.tmdbId!);
  const shows = items.filter((i) => i.type === "tv" && i.tmdbId).map((i) => i.tmdbId!);
  const [m, s] = await Promise.all([
    movies.length
      ? db.title.findMany({ where: { type: "movie", tmdbId: { in: movies }, files: { some: { status: "ready" } } }, select: { id: true, tmdbId: true, files: { where: { status: "ready" }, select: { id: true }, take: 1 } } })
      : [],
    shows.length
      ? db.title.findMany({ where: { type: "show", tmdbId: { in: shows }, episodes: { some: { files: { some: { status: "ready" } } } } }, select: { id: true, tmdbId: true } })
      : [],
  ]);
  const mm = new Map(m.map((t) => [t.tmdbId, t]));
  const ss = new Map(s.map((t) => [t.tmdbId, t]));
  return items.map((i) => {
    const hit = i.type === "movie" ? mm.get(i.tmdbId) : ss.get(i.tmdbId);
    if (!hit) return i;
    return { ...i, available: true, localId: hit.id, playFileId: i.type === "movie" ? (hit as (typeof m)[number]).files[0]?.id ?? null : null };
  });
}

export async function tmdbRow(path: string, params: Record<string, string | number> = {}, forced?: MediaKind): Promise<CardItem[]> {
  const data = await tmdb(path, params);
  const cards = (data.results ?? []).map((r: any) => tmdbToCard(r, forced)).filter(Boolean) as CardItem[];
  return annotateAvailability(cards.filter((c) => c.posterPath));
}

function localToCard(t: { id: string; type: string; tmdbId: number | null; title: string; year: number | null; posterPath: string | null; backdropPath: string | null; overview: string | null; rating: number | null }, extra: Partial<CardItem> = {}): CardItem {
  return {
    key: `local-${t.id}`,
    tmdbId: t.tmdbId,
    localId: t.id,
    type: t.type === "show" ? "tv" : "movie",
    title: t.title,
    year: t.year,
    posterPath: t.posterPath,
    backdropPath: t.backdropPath,
    overview: t.overview,
    rating: t.rating,
    available: true,
    ...extra,
  };
}

/** Recently added local titles (works without a TMDB key). */
export async function recentlyAdded(limit = 20): Promise<CardItem[]> {
  const [movies, shows] = await Promise.all([
    db.title.findMany({ where: { type: "movie", files: { some: { status: "ready" } } }, orderBy: { createdAt: "desc" }, take: limit, include: { files: { where: { status: "ready" }, take: 1, select: { id: true } } } }),
    db.title.findMany({ where: { type: "show", episodes: { some: { files: { some: { status: "ready" } } } } }, orderBy: { updatedAt: "desc" }, take: limit }),
  ]);
  const all = [
    ...movies.map((t) => ({ at: t.createdAt, card: localToCard(t, { playFileId: t.files[0]?.id }) })),
    ...shows.map((t) => ({ at: t.updatedAt, card: localToCard(t) })),
  ];
  return all.sort((a, b) => +b.at - +a.at).slice(0, limit).map((x) => x.card);
}

/** Continue watching: unfinished items (and the next episode after a finished one), most recent first. */
export async function continueWatching(profileId: string, limit = 20): Promise<CardItem[]> {
  const rows = await db.watchProgress.findMany({
    where: { profileId },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { mediaFile: { include: { episode: true, title: true } } },
  });
  const out: CardItem[] = [];
  const seenShows = new Set<string>();
  for (const r of rows) {
    const f = r.mediaFile;
    if (f.status !== "ready") continue;
    if (f.episode) {
      if (seenShows.has(f.episode.titleId)) continue;
      seenShows.add(f.episode.titleId);
      const show = await db.title.findUnique({ where: { id: f.episode.titleId } });
      if (!show) continue;
      if (!r.completed) {
        out.push(localToCard(show, { playFileId: f.id, progress: { position: r.positionSec, duration: r.durationSec }, subtitle: `S${f.episode.season}:E${f.episode.number}${f.episode.name ? " · " + f.episode.name : ""}` }));
      } else {
        const next = await nextEpisodeFile(f.episode.titleId, f.episode.season, f.episode.number);
        if (next) out.push(localToCard(show, { playFileId: next.fileId, subtitle: next.label }));
      }
    } else if (f.title && !r.completed) {
      out.push(localToCard(f.title, { playFileId: f.id, progress: { position: r.positionSec, duration: r.durationSec } }));
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** The next playable episode after (season, number) in a show. */
export async function nextEpisodeFile(titleId: string, season: number, number: number): Promise<{ fileId: string; label: string } | null> {
  const eps = await db.episode.findMany({
    where: { titleId, files: { some: { status: "ready" } } },
    orderBy: [{ season: "asc" }, { number: "asc" }],
    include: { files: { where: { status: "ready" }, take: 1, select: { id: true } } },
  });
  const next = eps.find((e) => e.season > season || (e.season === season && e.number > number));
  return next ? { fileId: next.files[0].id, label: `S${next.season}:E${next.number}${next.name ? " · " + next.name : ""}` } : null;
}

/** First playable episode of a show, resuming where this profile left off when possible. */
export async function showPlayTarget(titleId: string, profileId: string): Promise<{ fileId: string; label: string } | null> {
  const last = await db.watchProgress.findFirst({
    where: { profileId, titleId, episodeId: { not: null } },
    orderBy: { updatedAt: "desc" },
    include: { mediaFile: { include: { episode: true } } },
  });
  if (last?.mediaFile.episode && last.mediaFile.status === "ready") {
    const e = last.mediaFile.episode;
    if (!last.completed) return { fileId: last.mediaFileId, label: `S${e.season}:E${e.number}` };
    const n = await nextEpisodeFile(titleId, e.season, e.number);
    if (n) return n;
  }
  const first = await db.episode.findFirst({
    where: { titleId, files: { some: { status: "ready" } } },
    orderBy: [{ season: "asc" }, { number: "asc" }],
    include: { files: { where: { status: "ready" }, take: 1, select: { id: true } } },
  });
  return first ? { fileId: first.files[0].id, label: `S${first.season}:E${first.number}` } : null;
}

export async function myList(profileId: string): Promise<CardItem[]> {
  const rows = await db.watchlistItem.findMany({ where: { profileId }, orderBy: { createdAt: "desc" } });
  const cards: CardItem[] = rows.map((r) => ({
    key: `${r.mediaType}-${r.tmdbId}`, tmdbId: r.tmdbId, type: r.mediaType as MediaKind, title: r.title, posterPath: r.posterPath, available: false,
  }));
  return annotateAvailability(cards);
}

/** "Because you watched ..." rows from TMDB recommendations based on this profile's history and list. */
export async function recommendations(profileId: string, max = 2): Promise<{ title: string; items: CardItem[] }[]> {
  if (!(await tmdbConfigured())) return [];
  const [history, list] = await Promise.all([
    db.watchProgress.findMany({ where: { profileId }, orderBy: { updatedAt: "desc" }, take: 30, include: { mediaFile: { include: { title: true, episode: { include: { titleRef: true } } } } } }),
    db.watchlistItem.findMany({ where: { profileId }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  const seeds: { type: "movie" | "tv"; tmdbId: number; title: string }[] = [];
  const seen = new Set<string>();
  for (const h of history) {
    const t = h.mediaFile.title ?? h.mediaFile.episode?.titleRef;
    if (!t?.tmdbId) continue;
    const k = t.id;
    if (seen.has(k)) continue;
    seen.add(k);
    seeds.push({ type: t.type === "show" ? "tv" : "movie", tmdbId: t.tmdbId, title: t.title });
  }
  for (const l of list) if (!seen.has(`${l.mediaType}${l.tmdbId}`)) seeds.push({ type: l.mediaType as "movie" | "tv", tmdbId: l.tmdbId, title: l.title });
  const watched = new Set(seeds.filter((_, i) => i < seeds.length).map((s) => `${s.type}-${s.tmdbId}`));
  const rows: { title: string; items: CardItem[] }[] = [];
  for (const s of seeds.slice(0, max)) {
    try {
      const data = await getRecommendations(s.type, s.tmdbId);
      const cards = (data.results ?? []).map((r: any) => tmdbToCard(r, s.type)).filter((c: CardItem | null): c is CardItem => !!c && !!c.posterPath && !watched.has(c.key) && isRecent(c.year, TOP_RATED_YEARS));
      if (cards.length >= 4) rows.push({ title: `Because you watched ${s.title}`, items: await annotateAvailability(cards) });
    } catch {
      /* TMDB hiccup: skip the row */
    }
  }
  return rows;
}
