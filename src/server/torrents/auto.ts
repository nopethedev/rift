import "server-only";
import { getMovie, getSeason, getTv } from "../tmdb";
import { TorrentError, isTorrentError } from "./errors";
import { type PickQuery, rankCandidates } from "./pick";
import { buildSearchQuery, mergeResults, resolveTorrentSource, searchTorrentsDetailed, type TorrentSearchResult } from "./search";
import { getTorrentStreamer, type StreamView } from "./streamer";

export interface AutoStartInput {
  type: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  /** Info hashes already tried (retry after a dead source). */
  exclude?: string[];
  ownerId: string;
}

const yearOf = (d?: string | null) => (d && d.length >= 4 ? Number(d.slice(0, 4)) || null : null);

/**
 * "Play" for a title that is not in the library: look the title up on TMDB, search the configured torrent sources, pick the best
 * release (see pick.ts) and start an on-demand stream with it. The server does the search, so users never submit magnets themselves.
 */
export async function startStreamForTitle(input: AutoStartInput): Promise<StreamView> {
  let q: PickQuery;
  let title: string;
  let subtitle: string | undefined;
  if (input.type === "movie") {
    const m = await getMovie(input.tmdbId).catch(() => { throw new TorrentError("Could not look this title up on TMDB", 502); });
    title = m.title;
    q = { title, year: yearOf(m.release_date), mediaType: "movie" };
    subtitle = q.year ? String(q.year) : undefined;
  } else {
    const t = await getTv(input.tmdbId).catch(() => { throw new TorrentError("Could not look this show up on TMDB", 502); });
    title = t.name;
    const season = input.season ?? 1;
    const episode = input.episode ?? 1;
    q = { title, year: yearOf(t.first_air_date), mediaType: "tv", season, episode };
    const epName = await getSeason(input.tmdbId, season).then((s: any) => s.episodes?.find((e: any) => e.episode_number === episode)?.name as string | undefined).catch(() => undefined);
    subtitle = `S${season}:E${episode}${epName ? ` · ${epName}` : ""}`;
  }

  const category = input.type === "movie" ? "movies" : "tv";
  const queries = [buildSearchQuery({ title: q.title, year: q.year, mediaType: q.mediaType, season: q.season, episode: q.episode })];
  // Episodes are often only in season packs: search those too.
  if (q.mediaType === "tv") queries.push(buildSearchQuery({ title: q.title, mediaType: "tv", season: q.season }));
  const lists = await Promise.all(queries.map((s) => searchTorrentsDetailed(s, { category, limit: 60 }).catch(() => ({ results: [] as TorrentSearchResult[], providers: [] }))));
  const merged = mergeResults(lists.flatMap((l) => l.results), 150);
  const ranked = rankCandidates(merged, q, input.exclude ?? []);
  if (!ranked.length) {
    const failing = lists.flatMap((l) => l.providers).filter((p) => !p.ok);
    throw new TorrentError(
      merged.length
        ? `Found ${merged.length} torrents for "${title}" but none looked playable (no seeders, wrong release or unsupported format).`
        : `No sources found for "${title}".${failing.length ? " Some search providers failed, check Settings → Downloads." : " Enable a torrent search provider (or Torznab) in Settings."}`,
      404,
    );
  }

  const meta = { title, subtitle, backPath: `/title/${input.type}/${input.tmdbId}`, type: input.type, tmdbId: input.tmdbId, season: q.season, episode: q.episode };
  let lastErr: unknown;
  for (const c of ranked.slice(0, 3)) {
    try {
      const source = await resolveTorrentSource(c.result);
      return await getTorrentStreamer().start({ ...source, ownerId: input.ownerId, meta, episode: q.mediaType === "tv" ? { season: q.season!, episode: q.episode! } : undefined });
    } catch (e) {
      if (isTorrentError(e) && (e.status === 429 || e.status === 403 || e.status === 507)) throw e; // capacity / policy: no point trying another source
      lastErr = e;
    }
  }
  throw isTorrentError(lastErr) ? lastErr : new TorrentError("Could not open any of the matching sources", 502);
}
