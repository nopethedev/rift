// Picks the right recording for a requested song from search results: the studio version by the right artist,
// not a remix, cover, live take or karaoke track unless one was asked for. Pure functions, no I/O.
import type { TrackQuery } from "./music-protocol";

export const normalize = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Variant markers and the phrases that signal them (matched on normalized text). */
const VARIANTS: Record<string, RegExp> = {
  remix: /\b(remix|rmx|bootleg|rework|flip|vip mix)\b/,
  cover: /\b(cover|covered by|tribute|made famous by|originally performed|in the style of)\b/,
  live: /\b(live|concert|unplugged|in concert|live at|live from|live in|tour)\b/,
  karaoke: /\b(karaoke|backing track|minus one|sing along|instrumental version)\b/,
  instrumental: /\binstrumental\b/,
  acoustic: /\b(acoustic|stripped|piano version|unplugged)\b/,
  altspeed: /\b(sped up|speed up|slowed|reverb|nightcore|8d|bass boosted|daycore|pitched)\b/,
  mashup: /\b(mashup|mash up|medley)\b/,
  extended: /\b(extended|loop|1 hour|10 hours|hour version)\b/,
  nonmusic: /\b(reaction|tutorial|lesson|how to|review|type beat|parody|lyrics? video explained|piano tutorial|drum cover|guitar cover|behind the scenes|making of|interview|trailer)\b/,
};

export function variantFlags(text: string): Set<string> {
  const n = normalize(text);
  const out = new Set<string>();
  for (const [k, re] of Object.entries(VARIANTS)) if (re.test(n)) out.add(k);
  if (out.has("instrumental") || out.has("acoustic")) out.add("alt-arrangement");
  return out;
}

const STOP = new Set(["the", "a", "an", "and", "of", "feat", "ft", "featuring", "with", "official", "audio", "video", "lyrics", "lyric", "hd", "hq", "remastered", "remaster", "version", "edit", "music"]);

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter((t) => t && !STOP.has(t));
}

/** Strip "(feat. X)" style credits so title comparison focuses on the song name. */
export function baseTitle(title: string): string {
  return title.replace(/[([]\s*(feat\.?|ft\.?|featuring|with)[^)\]]*[)\]]/gi, "").replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "").trim();
}

export interface MatchInput {
  title: string;
  /** Uploader / channel / author. */
  artist: string;
  durationSec: number;
  isLive?: boolean;
}

export interface MatchResult { score: number; reasons: string[] }

export const MATCH_THRESHOLD = 0.55;

export function scoreCandidate(q: TrackQuery, c: MatchInput): MatchResult {
  const reasons: string[] = [];
  if (c.isLive) return { score: 0, reasons: ["live stream"] };
  const qTitle = tokens(baseTitle(q.title));
  const cTitleNorm = normalize(c.title);
  const cTokens = new Set(tokens(c.title));
  const chan = normalize(c.artist.replace(/\s*-\s*topic$/i, ""));
  const isTopic = /-\s*topic$/i.test(c.artist) || /provided to youtube by/i.test(c.title);

  // Title coverage (0..0.45): fraction of requested title words found in the result.
  let titlePart = 0;
  if (qTitle.length) {
    const hit = qTitle.filter((t) => cTokens.has(t) || cTitleNorm.includes(t)).length;
    titlePart = 0.45 * (hit / qTitle.length);
    if (hit < qTitle.length) reasons.push(`title ${hit}/${qTitle.length}`);
  }

  // Artist (0..0.25): artist words in the title or the channel.
  const qArtist = tokens(q.artist);
  let artistPart = 0;
  if (qArtist.length) {
    const hay = `${cTitleNorm} ${chan}`;
    const hit = qArtist.filter((t) => hay.includes(t)).length;
    artistPart = 0.25 * (hit / qArtist.length);
    if (hit === 0) reasons.push("artist not found");
  } else artistPart = 0.12;

  // Duration (0..0.25).
  let durPart = 0.08;
  if (q.durationSec && q.durationSec > 0 && c.durationSec > 0) {
    const diff = Math.abs(q.durationSec - c.durationSec);
    const rel = diff / q.durationSec;
    durPart = diff <= 2 ? 0.25 : diff <= 5 ? 0.2 : diff <= 10 ? 0.08 : 0;
    if (rel > 0.25) { durPart = -0.25; reasons.push(`duration off by ${Math.round(diff)}s`); }
  } else if (c.durationSec > 15 * 60) { durPart = -0.2; reasons.push("too long for a song"); }
  else if (c.durationSec > 0 && c.durationSec < 30) { durPart = -0.2; reasons.push("too short"); }

  let score = titlePart + artistPart + durPart + (isTopic ? 0.08 : 0) + (/\bofficial (audio|music video)\b/i.test(c.title) ? 0.04 : 0);

  // Variants: penalise what wasn't asked for, mildly reward what was.
  if (!q.allowVariants) {
    const wanted = variantFlags(`${q.title} ${q.album ?? ""}`);
    const got = variantFlags(c.title);
    for (const f of got) {
      if (f === "alt-arrangement") continue;
      if (!wanted.has(f)) { score -= f === "nonmusic" ? 0.6 : 0.4; reasons.push(`unwanted ${f}`); }
    }
    for (const f of wanted) if (f !== "alt-arrangement" && !got.has(f)) score -= 0.12;
  }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

export function rank<T extends { match: MatchResult }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.match.score - a.match.score);
}

/** Creative Commons / public-domain licence strings as reported by yt-dlp extractors. */
export function isOpenLicense(license: string | undefined | null): boolean {
  if (!license) return false;
  return /(creative\s*commons|\bcc[\s_-]?(by|0|zero)\b|\bcc\b|public\s*domain|\bcc0\b|\bpdm\b)/i.test(license) && !/all[\s_-]*rights[\s_-]*reserved/i.test(license);
}
