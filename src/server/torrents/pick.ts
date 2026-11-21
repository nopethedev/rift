import { parseMediaFilename, titleSimilarity } from "../library/filename";
import type { TorrentSearchResult } from "./search";

/**
 * Pick the best torrent for "play this title now". Pure scoring (tested); the network part lives in `findSources`.
 *
 * On-demand streams cannot be server-transcoded (the file is only partly there), so we prefer what a browser plays itself:
 * 8-bit H.264 in MP4/MKV with AAC or Dolby Digital(+) audio (Mediabunny converts that), 1080p/720p, healthy seeders, sane size.
 */

export interface PickQuery {
  title: string;
  year?: number | null;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
}

export interface Candidate { result: TorrentSearchResult; score: number; pack: boolean }

const GB = 1024 ** 3;
const BAD_SOURCE = /\b(cam|hdcam|camrip|hdts|hd-ts|telesync|telecine|dvdscr|screener|workprint|r5)\b/i;
const OTHER_LANG = /\b(french|truefrench|vostfr|german|italian|spanish|latino|hindi|russian|polish|korean|turkish|portuguese|swedish|dutch)\b/i;

export const hashOfResult = (r: Pick<TorrentSearchResult, "infoHash" | "magnet">): string | undefined =>
  r.infoHash?.toLowerCase() ?? /xt=urn:btih:([a-f0-9]{40})/i.exec(r.magnet ?? "")?.[1]?.toLowerCase();

/** Score one result for the query; null = unusable. */
export function scoreResult(r: TorrentSearchResult, q: PickQuery): Candidate | null {
  const name = r.title;
  if (BAD_SOURCE.test(name) || /\b3d\b/i.test(name) || /\b(sample|trailer)\b/i.test(name)) return null;
  const isArchive = r.provider === "Internet Archive";
  if (r.seeds < 1 && !isArchive) return null; // nobody to download from

  const p = parseMediaFilename(name);
  if (!p.title || titleSimilarity(p.title, q.title) < 0.85) return null;

  let pack = false;
  if (q.mediaType === "movie") {
    if (p.season !== undefined || p.episode !== undefined) return null; // an episode / season, not the movie
    if (p.year && q.year && Math.abs(p.year - q.year) > 1) return null;
  } else {
    if (p.season !== undefined && q.season !== undefined && p.season !== q.season) return null;
    if (p.episode !== undefined && q.episode !== undefined) {
      const last = p.episodeEnd ?? p.episode;
      if (q.episode < p.episode || q.episode > last) return null;
    } else if (q.episode !== undefined) {
      pack = true; // a season (or series) pack: the streamer picks the episode file inside it
    }
  }

  const bytes = r.sizeBytes ?? 0;
  if (bytes) {
    if (q.mediaType === "movie" && bytes > 25 * GB) return null;
    if (q.mediaType === "tv" && !pack && bytes > 10 * GB) return null;
    if (pack && bytes > 70 * GB) return null;
  }

  let score = Math.min(40, Math.log2(r.seeds + 1) * 7);
  const has = (re: RegExp) => re.test(name);
  // resolution
  if (has(/\b1080p\b/i)) score += 30; else if (has(/\b720p\b/i)) score += 22; else if (has(/\b(2160p|4k|uhd)\b/i)) score += 2; else if (has(/\b480p\b/i)) score += 8;
  // video the browser can decode
  if (has(/\b(x264|h\.?264|avc)\b/i)) score += 25;
  if (has(/\b(x265|h\.?265|hevc)\b/i)) score -= 12;
  if (has(/\b(10[- ]?bit|hi10p?)\b/i)) score -= 40; // 10-bit H.264 is not decodable in browsers
  if (has(/\b(hdr10?\+?|dolby[ .]?vision|dv|dovi)\b/i)) score -= 30;
  if (has(/\bav1\b/i)) score -= 8;
  // audio: DD/DD+ and AAC are fine (Mediabunny); DTS / TrueHD cannot be decoded in the browser
  if (has(/\b(dts|truehd|atmos|dts-?hd)\b/i) && !has(/\b(dd\+?|ddp|e-?ac-?3|aac)/i)) score -= 25;
  // source
  if (has(/\b(web-?dl|web-?rip|webrip|amzn|nf|hmax|dsnp)\b/i)) score += 10; else if (has(/\b(blu-?ray|bdrip|brrip)\b/i)) score += 6;
  if (has(/\bremux\b/i)) score -= 30;
  if (has(/\.mp4\b|\bmp4\b/i)) score += 8;
  if (OTHER_LANG.test(name) && !OTHER_LANG.test(q.title)) score -= 30;
  if (has(/\b(complete|collection|anthology)\b/i) && q.mediaType === "tv") score -= 15;
  // size: a few GB streams comfortably; huge files mean slow starts and cache use
  if (bytes) {
    const g = bytes / GB;
    const target = q.mediaType === "movie" ? 4 : pack ? 25 : 1.2;
    score -= Math.min(30, Math.abs(Math.log2((g + 0.1) / target)) * 6);
  }
  if (pack) score -= 6; // slightly prefer a single-episode release
  if (isArchive) score += 5;
  return { result: r, score, pack };
}

export function rankCandidates(results: TorrentSearchResult[], q: PickQuery, exclude: Iterable<string> = []): Candidate[] {
  const skip = new Set([...exclude].map((x) => x.toLowerCase()));
  const out: Candidate[] = [];
  for (const r of results) {
    const h = hashOfResult(r);
    if (h && skip.has(h)) continue;
    const c = scoreResult(r, q);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.score - a.score);
}
