// The CDN extractor: turns a song's page URL (what a Lavalink node returns from a search) into its audio file on the
// source's CDN, then downloads it. Ported from Rift Solo, which does the same on Android with NewPipe Extractor.
//
// Why: Lavalink only plays into a Discord-style voice connection, so Rift's voice sink has to catch the audio as the node
// plays it: in real time (a 4-minute song takes 4 minutes to cache) and only with a node that can reach the worker on
// TCP 4443 / UDP 4444 and trusts its certificate. Fetching from the CDN works with any node, including free remote ones,
// and finishes in seconds.
import type { TrackQuery } from "../../../shared/music-protocol";
import { MATCH_THRESHOLD, scoreCandidate } from "../../../shared/music-match";
import { EngineError } from "../engines/types";
import { extractBandcamp } from "./bandcamp";
import { extractSoundCloud } from "./soundcloud";
import type { DirectAudio } from "./types";
import { extractYouTube, searchYouTubeVideos, youtubeId } from "./youtube";

export type { DirectAudio } from "./types";
export { openDirect } from "./stream";

/** Lavalink sources whose tracks carry a page URL the extractor can open. */
export const DIRECT_SOURCES = new Set(["youtube", "youtubemusic", "soundcloud", "bandcamp"]);
/** LavaSrc catalogue sources (metadata only): played through a YouTube match. */
export const MIRRORED_SOURCES = new Set(["spotify", "applemusic", "deezer", "tidal", "yandexmusic", "amazonmusic", "vkmusic"]);

/** Set MUSIC_DIRECT=0 on the worker to always use the voice sink for Lavalink tracks. */
export const directEnabled = () => process.env.MUSIC_DIRECT !== "0";

const cache = new Map<string, DirectAudio>();
const MARGIN_MS = 10 * 60_000;

export async function extract(pageUrl: string, sourceName?: string): Promise<DirectAudio> {
  const hit = cache.get(pageUrl);
  if (hit && hit.expiresAt - MARGIN_MS > Date.now()) return hit;
  const src = (sourceName ?? "").toLowerCase();
  let a: DirectAudio;
  if (youtubeId(pageUrl) || src === "youtube" || src === "youtubemusic") a = await extractYouTube(pageUrl);
  else if (/soundcloud\.com\//.test(pageUrl) || src === "soundcloud") a = await extractSoundCloud(pageUrl);
  else if (/bandcamp\.com\//.test(pageUrl) || src === "bandcamp") a = await extractBandcamp(pageUrl);
  else throw new EngineError(`No direct extractor for ${src || pageUrl}`, "unavailable");
  cache.set(pageUrl, a);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return a;
}

export interface Recording { title: string; artist: string; durationSec: number; url: string }

/**
 * Other YouTube uploads of a song: for catalogue-only tracks (Spotify...) and when the chosen upload is refused (YouTube
 * Music "Topic" song uploads are licensed differently from video uploads, so one often plays when the other doesn't).
 * Only close matches (title/artist/duration, Rift's usual matcher), best first.
 */
export async function alternatives(q: TrackQuery, exclude: string[] = [], limit = 3): Promise<Recording[]> {
  const found = await searchYouTubeVideos(`${q.artist} ${q.title}`.trim(), 8);
  return found
    .filter((v) => !exclude.some((u) => youtubeId(u) === v.id))
    .map((v) => ({ v, score: scoreCandidate(q, { title: v.title, artist: v.artist, durationSec: v.durationSec }).score }))
    .filter((x) => x.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.v);
}

/**
 * Extract with fallbacks: the page itself (unless it's a catalogue-only source), then up to [tries] matching YouTube
 * uploads. Throws the last error when nothing plays.
 */
export async function extractBest(c: { url: string; sourceName?: string; title: string; artist: string; durationSec: number }, tries = 3): Promise<DirectAudio> {
  const src = (c.sourceName ?? "").toLowerCase();
  let last: Error | undefined;
  if (!MIRRORED_SOURCES.has(src) && c.url) {
    try { return await extract(c.url, src); } catch (e) { last = e as Error; }
    if (!DIRECT_SOURCES.has(src) && !youtubeId(c.url)) throw last;
  }
  for (const alt of await alternatives({ title: c.title, artist: c.artist, durationSec: c.durationSec || undefined }, [c.url], tries).catch(() => [])) {
    try { return await extract(alt.url, "youtube"); } catch (e) { last = e as Error; }
  }
  throw last ?? new EngineError(`Couldn't find a playable upload of "${c.title}"`, "not-found");
}
