// Music taste profile + matching. Pure (no DB / network) so it is unit tested; src/server/music/taste.ts feeds it.
//
// The profile is built from what a listener actually does:
//   finished plays  ≫ half plays  ≫ skips (a skip counts against the song and a little against the artist)
//   liked songs (strong, decays slowly) · songs put in playlists · artists/genres picked during onboarding
// Every signal fades with age (plays: 60-day half-life, likes and playlists: 180 days). Onboarding picks start strong
// and fade as real listening arrives, so after a few dozen songs the history decides.
//
// Matching scores a candidate song by: the listener's affinity for its artist, for artists it is *related* to (Deezer's
// "fans also like" graph), an optional context (the playlist or the queue being extended), its genre and decade, and
// a little popularity. Recently played songs are left out and skipped songs pushed down. `pickDiverse` then picks the
// best songs while spreading artists out, so a mix isn't ten songs by one band. Every pick carries a short reason.
import { baseTitle, normalize } from "@shared/music-match";

export interface PlaySignal { artist: string; title: string; genre?: string | null; year?: number | null; playedSec: number; durationSec?: number | null; completed: boolean; ageDays: number }
export interface SongSignal { artist: string; title: string; genre?: string | null; year?: number | null; ageDays: number }
export interface TastePicks { artists: string[]; genres: string[] }
export interface TasteInput { plays: PlaySignal[]; likes: SongSignal[]; playlisted: SongSignal[]; picks: TastePicks }

export interface Ranked { key: string; name: string; score: number }
export interface MusicTaste {
  /** 0..1, best first. Only artists with a positive balance. */
  artists: Ranked[];
  genres: Ranked[];
  decades: { decade: number; score: number }[];
  /** song key -> affinity; negative = skipped more than enjoyed. */
  songs: Map<string, number>;
  /** Songs heard in the last day or among the last 30 plays: not recommended again yet. */
  recent: Set<string>;
  /** Artists skipped much more than played. */
  avoid: Set<string>;
  /** How much of the profile comes from listening rather than onboarding picks (0..1). */
  learned: number;
  /** Counted signals (plays + likes + playlist songs). */
  signals: number;
}

const half = (days: number, h: number) => Math.pow(0.5, Math.max(0, days) / h);
const PLAY_HALF_LIFE = 60;
const KEEP_HALF_LIFE = 180;
/** A pick is worth about five finished plays at first and fades to a fifth of that as history builds up. */
const PICK_WEIGHT = 5;

export const artistKey = (a: string) => normalize(a);
export const songKey = (artist: string, title: string) => `${normalize(splitArtists(artist)[0] ?? artist)}|${normalize(baseTitle(title)) || normalize(title)}`;
export const genreKey = (g: string) => normalize(g).replace(/\b(music|musik)\b/g, "").replace(/\s+/g, " ").trim();

/** "A, B feat. C" -> ["A", "B", "C"]. "&" stays (Simon & Garfunkel). */
export function splitArtists(s: string): string[] {
  return s.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring|with|x)\s+/i).map((x) => x.trim()).filter(Boolean);
}

/** How much a play says about liking the song: finished 1, half-way ~0.65, a quick skip is negative. */
export function playWeight(p: Pick<PlaySignal, "playedSec" | "durationSec" | "completed">): number {
  if (p.completed) return 1;
  const frac = p.durationSec ? Math.min(1, p.playedSec / p.durationSec) : p.playedSec / 200;
  if (p.playedSec < 30 && frac < 0.5) return -0.6;
  return 0.3 + 0.7 * frac;
}

export function buildTaste(input: TasteInput): MusicTaste {
  const artistRaw = new Map<string, { name: string; v: number }>();
  const genreRaw = new Map<string, { name: string; v: number }>();
  const decadeRaw = new Map<number, number>();
  const songs = new Map<string, number>();
  const recent = new Set<string>();
  let learned = 0;
  let signals = 0;

  const addArtist = (name: string, w: number) => {
    splitArtists(name).forEach((a, i) => {
      const k = artistKey(a);
      if (!k || k === "unknown artist") return;
      const cur = artistRaw.get(k) ?? { name: a, v: 0 };
      cur.v += i === 0 ? w : w * 0.5; // featured artists count half
      artistRaw.set(k, cur);
    });
  };
  const addGenre = (g: string | null | undefined, w: number) => {
    if (!g) return;
    for (const part of g.split(/[;/,]/)) {
      const k = genreKey(part);
      if (!k) continue;
      const cur = genreRaw.get(k) ?? { name: part.trim(), v: 0 };
      cur.v += w;
      genreRaw.set(k, cur);
    }
  };
  const addYear = (y: number | null | undefined, w: number) => { if (y && y > 1900 && y < 2100) { const d = Math.floor(y / 10) * 10; decadeRaw.set(d, (decadeRaw.get(d) ?? 0) + w); } };
  const addSong = (k: string, w: number) => songs.set(k, (songs.get(k) ?? 0) + w);

  input.plays.forEach((p, i) => {
    const k = songKey(p.artist, p.title);
    if (i < 30 || p.ageDays < 1) recent.add(k);
    const pw = playWeight(p);
    const w = pw * half(p.ageDays, PLAY_HALF_LIFE);
    signals++;
    addSong(k, w);
    if (pw > 0) {
      learned += w;
      addArtist(p.artist, w);
      addGenre(p.genre, w);
      addYear(p.year, w);
    } else addArtist(p.artist, w * 0.25); // a skip says little about the artist
  });
  for (const l of input.likes) {
    const w = half(l.ageDays, KEEP_HALF_LIFE);
    signals++;
    learned += 2 * w;
    addSong(songKey(l.artist, l.title), 3 * w);
    addArtist(l.artist, 2.5 * w);
    addGenre(l.genre, 2 * w);
    addYear(l.year, w);
  }
  for (const l of input.playlisted) {
    const w = half(l.ageDays, KEEP_HALF_LIFE);
    signals++;
    learned += 0.5 * w;
    addSong(songKey(l.artist, l.title), w);
    addArtist(l.artist, 0.8 * w);
    addGenre(l.genre, 0.6 * w);
    addYear(l.year, 0.4 * w);
  }
  const pickW = PICK_WEIGHT * Math.max(0.2, 1 - learned / 40);
  for (const a of input.picks.artists) addArtist(a, pickW);
  for (const g of input.picks.genres) addGenre(g, pickW);

  const rank = (m: Map<string, { name: string; v: number }>): Ranked[] => {
    const pos = [...m.entries()].filter(([, x]) => x.v > 0.05);
    const max = Math.max(0, ...pos.map(([, x]) => x.v));
    return pos.map(([key, x]) => ({ key, name: x.name, score: max ? Math.log1p(x.v) / Math.log1p(max) : 0 })).sort((a, b) => b.score - a.score);
  };
  const dmax = Math.max(0, ...decadeRaw.values());
  return {
    artists: rank(artistRaw),
    genres: rank(genreRaw),
    decades: [...decadeRaw.entries()].filter(([, v]) => v > 0).map(([decade, v]) => ({ decade, score: dmax ? v / dmax : 0 })).sort((a, b) => b.score - a.score),
    songs,
    recent,
    avoid: new Set([...artistRaw.entries()].filter(([, x]) => x.v < -0.5).map(([k]) => k)),
    learned: Math.min(1, learned / 40),
    signals,
  };
}

// ---------- matching ----------
export interface TrackCandidate {
  artist: string;
  title: string;
  genre?: string | null;
  year?: number | null;
  /** 0..1 (chart position, rank in an artist's top songs). */
  popularity?: number;
  /** Artists this song's artist is similar to (artist name as found in the taste/context, 0..1 strength). */
  related?: { to: string; strength: number }[];
}
export interface MatchContext {
  /** Artist name -> weight 0..1: the playlist being extended or the last songs in the queue. */
  artists: Map<string, number>;
  /** How much the context counts (playlist: high, autoplay: medium). */
  weight: number;
  /** How much the listener's overall taste still counts next to it (default 1). */
  tasteWeight?: number;
}
export interface Match<T> { item: T; score: number; reason: string; artistKey: string; songKey: string }

const W = { artist: 1, related: 0.75, context: 1, genre: 0.35, decade: 0.15, popularity: 0.2, favourite: 0.15 };

function lookup(t: MusicTaste) {
  const artists = new Map(t.artists.map((a) => [a.key, a]));
  const genres = new Map(t.genres.map((g) => [g.key, g]));
  const decades = new Map(t.decades.map((d) => [d.decade, d.score]));
  return { artists, genres, decades };
}

/** Score candidates against a taste (and optional context). Recently played songs are dropped. */
export function scoreTracks<T>(taste: MusicTaste, items: { item: T; c: TrackCandidate }[], ctx?: MatchContext): Match<T>[] {
  const L = lookup(taste);
  const ctxMap = new Map([...(ctx?.artists ?? new Map<string, number>()).entries()].map(([k, v]) => [artistKey(k), { name: k, v }]));
  const out: Match<T>[] = [];
  for (const { item, c } of items) {
    const names = splitArtists(c.artist);
    const ak = artistKey(names[0] ?? c.artist);
    const sk = songKey(c.artist, c.title);
    if (!ak || taste.recent.has(sk)) continue;
    const parts: { v: number; why: string; ctx?: true }[] = [];

    // affinity for the artist (or a featured one, at half)
    let a = 0, aName = names[0] ?? c.artist;
    names.forEach((n, i) => { const x = L.artists.get(artistKey(n)); if (x && x.score * (i ? 0.5 : 1) > a) { a = x.score * (i ? 0.5 : 1); aName = x.name; } });
    parts.push({ v: W.artist * a, why: `You listen to ${aName}` });

    // related to artists the listener (or the context) likes
    let r = 0, rName = "", cr = 0, crName = "";
    for (const rel of c.related ?? []) {
      const k = artistKey(rel.to);
      const x = L.artists.get(k);
      if (x && x.score * rel.strength > r) { r = x.score * rel.strength; rName = x.name; }
      const cx = ctxMap.get(k);
      if (cx && cx.v * rel.strength > cr) { cr = cx.v * rel.strength; crName = cx.name; }
    }
    parts.push({ v: W.related * r, why: `Similar to ${rName}` });

    if (ctx) {
      const direct = ctxMap.get(ak);
      const cv = Math.max(direct?.v ?? 0, cr * 0.8);
      parts.push({ v: W.context * ctx.weight * cv, why: direct ? `More ${direct.name}` : `Like ${crName}`, ctx: true });
    }

    let g = 0, gName = "";
    if (c.genre) for (const part of c.genre.split(/[;/,]/)) { const x = L.genres.get(genreKey(part)); if (x && x.score > g) { g = x.score; gName = x.name; } }
    parts.push({ v: W.genre * g, why: `${gName} you like` });
    if (c.year) parts.push({ v: W.decade * (L.decades.get(Math.floor(c.year / 10) * 10) ?? 0), why: `From the ${Math.floor(c.year / 10) * 10}s` });
    parts.push({ v: W.popularity * (c.popularity ?? 0), why: "Popular right now", ctx: true });

    const fav = taste.songs.get(sk) ?? 0;
    if (fav > 0) parts.push({ v: W.favourite * Math.min(1, fav / 3), why: "One of your favourites" });

    const tw = ctx?.tasteWeight ?? 1;
    for (const p of parts) if (!p.ctx) p.v *= tw; // the context and popularity aren't part of the listener's taste
    let score = parts.reduce((s, p) => s + p.v, 0);
    if (fav < 0) score -= Math.min(1, -fav); // skipped before
    if (taste.avoid.has(ak)) score -= 0.6;
    const best = parts.reduce((m, p) => (p.v > m.v ? p : m), { v: 0, why: "Something new" });
    out.push({ item, score, reason: best.v > 0.02 ? best.why : "Something new", artistKey: ak, songKey: sk });
  }
  return out;
}

/**
 * The best `n`, spread out: each further song by an artist already picked costs `artistPenalty`, at most `perArtist`
 * per artist, never the same song twice, and never the same artist twice in a row when anything else is left.
 */
export function pickDiverse<T>(scored: Match<T>[], n: number, o: { perArtist?: number; artistPenalty?: number; jitter?: number; rand?: () => number } = {}): Match<T>[] {
  const perArtist = o.perArtist ?? 2;
  const penalty = o.artistPenalty ?? 0.3;
  const rand = o.rand ?? Math.random;
  const pool = scored.map((m) => ({ m, s: m.score + (o.jitter ?? 0.08) * rand() }));
  const count = new Map<string, number>();
  const songs = new Set<string>();
  const out: Match<T>[] = [];
  while (out.length < n && pool.length) {
    const last = out[out.length - 1]?.artistKey;
    let bi = -1, bs = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { m, s } = pool[i];
      if (songs.has(m.songKey) || (count.get(m.artistKey) ?? 0) >= perArtist) continue;
      const adj = s - penalty * (count.get(m.artistKey) ?? 0) - (m.artistKey === last ? 0.5 : 0);
      if (adj > bs) { bs = adj; bi = i; }
    }
    if (bi < 0) break;
    const [{ m }] = pool.splice(bi, 1);
    out.push(m);
    songs.add(m.songKey);
    count.set(m.artistKey, (count.get(m.artistKey) ?? 0) + 1);
  }
  return out;
}

/** Context from a list of songs (a playlist, the queue): artist -> share, the most frequent = 1. */
export function contextOf(songs: { artist: string }[], weight: number, tasteWeight = 1): MatchContext {
  const m = new Map<string, { name: string; n: number }>();
  for (const s of songs) {
    const a = splitArtists(s.artist)[0];
    const k = a ? artistKey(a) : "";
    if (!k || k === "unknown artist") continue;
    const cur = m.get(k) ?? { name: a, n: 0 };
    cur.n++;
    m.set(k, cur);
  }
  const max = Math.max(1, ...[...m.values()].map((x) => x.n));
  return { artists: new Map([...m.values()].map((x) => [x.name, Math.sqrt(x.n / max)])), weight, tasteWeight };
}
