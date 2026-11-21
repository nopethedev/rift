// Pure media filename parser (no server-only / db imports so it can be unit tested).

export interface ParsedMediaName {
  kind: "movie" | "episode";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Last episode of a multi-episode file (S01E01E02 / S01E01-E03). */
  episodeEnd?: number;
  /** True when no season was found in the name or folders and season 1 was assumed. */
  seasonGuessed?: boolean;
}

export const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg", "ogv"] as const;
const VIDEO_EXT_SET = new Set<string>(VIDEO_EXTENSIONS);

const extOf = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT_SET.has(extOf(name));
}

/** "Sample" clips shipped with scene releases (file or folder named sample). */
export function isSampleFile(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() ?? "";
  if (parts.some((p) => /^samples?$/i.test(p))) return true;
  const stem = base.replace(/\.[^.]+$/, "");
  return /(^|[\s._\-[(])sample($|[\s._\-\])])/i.test(stem);
}

// Tokens that mark the start of the "release info" part of a scene name.
const RELEASE_TAG =
  /^(?:2160p|1080p|1080i|720p|576p|540p|480p|360p|4k|uhd|8k|hdr|hdr10|hdr10plus|dv|dovi|sdr|blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|webrip|web|hdtv|pdtv|dsr|dvdrip|dvdscr|dvd|dvd5|dvd9|hdrip|hdcam|cam|ts|telesync|tc|r5|scr|screener|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|av1|vp9|10bit|8bit|12bit|aac(?:2\.0|5\.1)?|ac3|eac3|dd(?:p)?(?:2\.0|5\.1|7\.1)?|ddp?5|dts(?:-?hd)?|truehd|atmos|flac|mp3|opus|5\.1|7\.1|2\.0|proper|repack|rerip|real|internal|limited|extended|uncut|unrated|remastered|criterion|imax|theatrical|directors?|dc|multi|multisubs|dual|dubbed|subbed|vostfr|truefrench|french|german|ita|spanish|nf|amzn|hulu|dsnp|atvp|hmax|max|pcok|stan|hbo|it|complete|season|nordic|hc|3d|sbs|hsbs|ou|hou|readnfo|nfo|rip|ws|fs|retail|custom|subs?)$/i;

const SEASON_DIR = /^(?:season|series|saison|staffel|temporada|stagione|seizoen|s)[\s._-]*(\d{1,3})(?:\b.*)?$/i;
const SPECIALS_DIR = /^(?:specials?|extras?)$/i;

/** Turn "The.Movie.Name" / "the_movie_name" into "The Movie Name". */
function despace(s: string): string {
  let out = s;
  if (!/\s/.test(out)) out = out.replace(/[._]+/g, " ");
  else out = out.replace(/_+/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** Remove bracketed tags, release info and trailing group names from a (despaced) title. */
function stripReleaseInfo(s: string): string {
  let t = s
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\((?![12]\d{3}\))[^)]*(?:p|bit|rip|web|x26\d|hevc|dl)[^)]*\)/gi, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[(\-]+|[)\-,]+$/g, "");
    // only treat a tag as the end of the title once we already have a title word
    const bare = w.replace(/-[A-Za-z0-9]+$/, ""); // "x264-GRP" -> "x264"
    if (kept.length > 0 && (RELEASE_TAG.test(w) || RELEASE_TAG.test(bare))) break;
    kept.push(words[i]);
  }
  t = kept.join(" ");
  return cleanTitle(t);
}

function cleanTitle(s: string): string {
  return s
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/^[\s\-–:,.]+|[\s\-–:,.([]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const YEAR_RE = /(?:^|[\s.([_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/g;

/** Find the year that most likely is the release year (the last one that is not the first word). */
function findYear(s: string): { year: number; index: number } | null {
  const now = new Date().getFullYear() + 2;
  let best: { year: number; index: number } | null = null;
  for (const m of s.matchAll(YEAR_RE)) {
    const year = Number(m[1]);
    if (year < 1900 || year > now) continue;
    const index = (m.index ?? 0) + m[0].indexOf(m[1]);
    if (index === 0) continue; // "2001 A Space Odyssey" — leading number is part of the title
    best = { year, index };
  }
  return best;
}

/** Title (+ optional year) from a free piece of text such as a folder name or the part before SxxEyy. */
function titleAndYear(raw: string): { title: string; year?: number } {
  const s = despace(raw);
  const y = findYear(s);
  if (y) {
    const before = cleanTitle(s.slice(0, y.index).replace(/[([]\s*$/, ""));
    if (before) return { title: stripReleaseInfo(before) || before, year: y.year };
  }
  return { title: stripReleaseInfo(s) };
}

interface EpisodeMatch {
  season?: number;
  episode: number;
  episodeEnd?: number;
  index: number; // start of the match in the stem
}

function matchEpisode(stem: string): EpisodeMatch | null {
  // S01E02, S01E01E02, S01E01-E03, S01E01-03, S01 E02, s1e2
  let m = /(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})((?:[\s._-]*(?:-|e|-e)[\s._-]*\d{1,4}(?![\dp]))*)/i.exec(stem);
  if (m) {
    const season = Number(m[1]);
    const episode = Number(m[2]);
    const more = [...(m[3] ?? "").matchAll(/(\d{1,4})/g)].map((x) => Number(x[1])).filter((n) => n > episode && n - episode < 50);
    const end = more.length ? Math.max(...more) : undefined;
    return { season, episode, episodeEnd: end, index: m.index + (m[0].match(/^[^a-z0-9]/i) ? 1 : 0) };
  }
  // 1x02, 1x02-03
  m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:[-_](?:\d{1,2}x)?(\d{2,3}))?(?![\dp])/i.exec(stem);
  if (m) {
    const episode = Number(m[2]);
    const end = m[3] ? Number(m[3]) : undefined;
    return { season: Number(m[1]), episode, episodeEnd: end && end > episode ? end : undefined, index: m.index + (m[0].match(/^[^a-z0-9]/i) ? 1 : 0) };
  }
  // "Season 1 Episode 2"
  m = /(?:^|[^a-z0-9])season[\s._-]*(\d{1,3})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,4})/i.exec(stem);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), index: m.index + (m[0].match(/^[^a-z0-9]/i) ? 1 : 0) };
  // "Episode 02" / "Ep 02" / "Ep.02" / "E02" (season from folder)
  m = /(?:^|[^a-z0-9])(?:episode|ep|e)[\s._-]*(\d{1,4})(?:[\s._-]*(?:-|e)[\s._-]*(\d{1,4}))?(?![\dp])/i.exec(stem);
  if (m) {
    const episode = Number(m[1]);
    const end = m[2] ? Number(m[2]) : undefined;
    return { episode, episodeEnd: end && end > episode ? end : undefined, index: m.index + (m[0].match(/^[^a-z0-9]/i) ? 1 : 0) };
  }
  return null;
}

/**
 * Parse a media file path relative to its library root (or just a filename) into a movie / episode guess.
 * Folder context is used for show names ("Show/Season 2/05 - Title.mkv") and generic movie filenames.
 */
export function parseMediaFilename(relativePath: string): ParsedMediaName {
  const parts = relativePath.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..");
  const file = parts.pop() ?? "";
  const stem = isVideoFile(file) || /\.[a-z0-9]{2,4}$/i.test(file) ? file.replace(/\.[^.]+$/, "") : file;
  const dirs = parts.reverse(); // nearest first

  // season context from folders
  let dirSeason: number | undefined;
  let showDirIdx = -1;
  for (let i = 0; i < dirs.length; i++) {
    const d = despace(dirs[i]);
    const sm = SEASON_DIR.exec(d);
    if (sm && !/^s\d{1,3}e\d/i.test(d)) {
      dirSeason ??= Number(sm[1]);
      continue;
    }
    if (SPECIALS_DIR.test(d)) {
      dirSeason ??= 0;
      continue;
    }
    showDirIdx = i;
    break;
  }
  const showDir = showDirIdx >= 0 ? dirs[showDirIdx] : undefined;

  // Strip "[Group] " prefixes (anime / fansub style) before matching.
  const groupPrefix = /^\s*\[[^\]]+\]\s*/.exec(stem);
  const body = groupPrefix ? stem.slice(groupPrefix[0].length) : stem;

  let ep = matchEpisode(body);
  // "05 - Title" / "05. Title" / "05" inside a season folder
  if (!ep && dirSeason !== undefined) {
    const m = /^\s*(\d{1,3})(?=$|[\s._-])/.exec(body);
    if (m) ep = { episode: Number(m[1]), index: 0 };
  }
  // Fansub absolute numbering: "[Group] Show Name - 05 [1080p]"
  if (!ep && groupPrefix) {
    const m = /^(.*?)\s+-\s+(\d{1,4})(?:v\d)?(?=$|[\s[(])/.exec(body);
    if (m && m[1].trim()) {
      const n = Number(m[2]);
      if (!(n >= 1900 && n <= 2100)) ep = { season: undefined, episode: n, index: m[1].length };
    }
  }

  if (ep) {
    const season = ep.season ?? dirSeason ?? 1;
    let { title, year } = titleAndYear(body.slice(0, ep.index));
    if (!title && showDir) ({ title, year } = titleAndYear(showDir));
    if (!title && dirs[0]) title = titleAndYear(dirs[0]).title;
    const res: ParsedMediaName = { kind: "episode", title: title || stripReleaseInfo(despace(body)), season, episode: ep.episode };
    if (year) res.year = year;
    if (ep.episodeEnd && ep.episodeEnd > ep.episode) res.episodeEnd = ep.episodeEnd;
    if (ep.season === undefined && dirSeason === undefined) res.seasonGuessed = true;
    return res;
  }

  // Movie
  const own = titleAndYear(body);
  const generic = !own.title || /^(movie|video|film|feature|main|title|vts[\s_]\d+.*|\d+)$/i.test(own.title);
  if (dirs[0] && (generic || !own.year)) {
    const fromDir = titleAndYear(dirs[0]);
    if (fromDir.title && (generic || fromDir.year)) {
      const res: ParsedMediaName = { kind: "movie", title: fromDir.title };
      if (fromDir.year ?? own.year) res.year = fromDir.year ?? own.year;
      return res;
    }
  }
  const res: ParsedMediaName = { kind: "movie", title: own.title || despace(body) };
  if (own.year) res.year = own.year;
  return res;
}

/** Normalize a title for fuzzy comparison: lowercase ASCII, no punctuation/articles. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

/** Similarity 0..1 between two titles (Dice coefficient over bigrams of normalized titles). */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a).replace(/ /g, "");
  const y = normalizeTitle(b).replace(/ /g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const [g, c] of gx) inter += Math.min(c, gy.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}
