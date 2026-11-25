import "server-only";
// Server side of the music taste profile (src/lib/music-taste.ts): gathers a profile's signals from the database and
// finds candidate songs (the library, and the Deezer catalogue: the listener's artists, their top songs, "fans also
// like" artists and artist radios), then ranks them with the pure matcher. Catalogue lookups are cached for hours
// (src/server/cache.ts), so recommendations don't hit Deezer again on every call.
import { db } from "../db";
import { buildTaste, contextOf, pickDiverse, scoreTracks, songKey, artistKey, type MusicTaste, type TasteInput, type TrackCandidate } from "@/lib/music-taste";
import { catInput, type CatTrack, type ItemInput } from "@/lib/music-types";
import { coverUrl } from "./catalog";
import { artistRadio, artistRelated, artistTop, charts, findArtist, genres as dzGenres, onlineEnabled } from "./online";

const DAY = 86400_000;
const days = (d: Date) => (Date.now() - d.getTime()) / DAY;

export interface MusicTastePicks { artists: { id?: string | null; name: string; pictureUrl?: string | null }[]; genres: { id?: string | null; name: string }[] }

export function parseMusicPicks(raw: string | null | undefined): MusicTastePicks {
  try {
    const v = JSON.parse(raw ?? "") as Partial<MusicTastePicks>;
    return {
      artists: (Array.isArray(v.artists) ? v.artists : []).filter((a) => a && typeof a.name === "string").slice(0, 30),
      genres: (Array.isArray(v.genres) ? v.genres : []).filter((g) => g && typeof g.name === "string").slice(0, 12),
    };
  } catch { return { artists: [], genres: [] }; }
}

export async function tasteInput(profileId: string): Promise<{ input: TasteInput; picks: MusicTastePicks }> {
  const [profile, plays, saved, listed] = await Promise.all([
    db.profile.findUnique({ where: { id: profileId }, select: { musicTaste: true } }),
    db.musicPlay.findMany({ where: { profileId, playedAt: { gt: new Date(Date.now() - 365 * DAY) } }, orderBy: { playedAt: "desc" }, take: 1500 }),
    db.musicSaved.findMany({ where: { profileId }, orderBy: { createdAt: "desc" }, take: 1000 }),
    db.musicPlaylistItem.findMany({ where: { playlist: { profileId } }, select: { title: true, artist: true, playlist: { select: { updatedAt: true } }, track: { select: { genre: true, year: true } } }, take: 3000 }),
  ]);
  const ids = [...new Set(plays.flatMap((p) => (p.trackId ? [p.trackId] : [])))];
  const years = new Map((await db.musicTrack.findMany({ where: { id: { in: ids } }, select: { id: true, year: true } })).map((t) => [t.id, t.year]));
  const picks = parseMusicPicks(profile?.musicTaste);
  return {
    picks,
    input: {
      plays: plays.map((p) => ({ artist: p.artist, title: p.title, genre: p.genre, year: p.trackId ? years.get(p.trackId) ?? null : null, playedSec: p.playedSec, durationSec: p.durationSec, completed: p.completed, ageDays: days(p.playedAt) })),
      likes: saved.map((s) => ({ artist: s.artist, title: s.title, ageDays: days(s.createdAt) })),
      playlisted: listed.map((l) => ({ artist: l.artist, title: l.title, genre: l.track?.genre, year: l.track?.year, ageDays: days(l.playlist.updatedAt) })),
      picks: { artists: picks.artists.map((a) => a.name), genres: picks.genres.map((g) => g.name) },
    },
  };
}

const g = globalThis as unknown as { __riftTaste?: Map<string, { at: number; t: MusicTaste; picks: MusicTastePicks }> };
const memo = (g.__riftTaste ??= new Map());
export const forgetTaste = (profileId: string) => memo.delete(profileId);

/** The profile's taste (recomputed at most once a minute). */
export async function musicTasteOf(profileId: string): Promise<MusicTaste & { picks: MusicTastePicks }> {
  const hit = memo.get(profileId);
  if (hit && Date.now() - hit.at < 60_000) return { ...hit.t, picks: hit.picks };
  const { input, picks } = await tasteInput(profileId);
  const t = buildTaste(input);
  memo.set(profileId, { at: Date.now(), t, picks });
  if (memo.size > 200) memo.delete(memo.keys().next().value!);
  return { ...t, picks };
}

// ---------- candidates ----------
export interface Rec { key: string; input: ItemInput; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; trackId: string | null; reason: string }
interface Cand { rec: Rec; c: TrackCandidate }

const catRec = (t: CatTrack): Rec => ({ key: `dz:${t.id}`, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, artworkUrl: t.artworkUrl, trackId: null, reason: "" });

/** Deezer genre for a name from the library or onboarding ("Hip-Hop" -> "Rap/Hip Hop"). */
async function deezerGenre(names: string[]): Promise<{ id: string; name: string } | null> {
  const list = await dzGenres().catch(() => []);
  const alias: Record<string, string> = { "hip hop": "rap/hip hop", "hip-hop": "rap/hip hop", rap: "rap/hip hop", rnb: "r&b", electronic: "electro", edm: "electro", house: "electro", techno: "electro", indie: "alternative", "heavy metal": "metal", soul: "soul & funk", funk: "soul & funk", latin: "latin music" };
  for (const n of names) {
    const want = alias[n.toLowerCase()] ?? n.toLowerCase();
    const hit = list.find((x) => x.name.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

/** Songs around some seed artists: their top songs, "fans also like" artists' top songs, and their artist radio. */
async function catalogCandidates(seeds: string[], genreNames: string[]): Promise<Cand[]> {
  const out: Cand[] = [];
  const seedArtists = (await Promise.all(seeds.slice(0, 4).map((n) => findArtist(n).catch(() => null)))).filter((a) => !!a);
  await Promise.all(seedArtists.map(async (a) => {
    const [top, related, radio] = await Promise.all([artistTop(a.id, 10).catch(() => []), artistRelated(a.id, 8).catch(() => []), artistRadio(a.id, 25).catch(() => [])]);
    top.forEach((t, i) => out.push({ rec: catRec(t), c: { artist: t.artist, title: t.title, popularity: 1 - i / 12 } }));
    radio.forEach((t) => out.push({ rec: catRec(t), c: { artist: t.artist, title: t.title, popularity: 0.4, related: artistKey(t.artist) === artistKey(a.name) ? [] : [{ to: a.name, strength: 0.6 }] } }));
    const relTops = await Promise.all(related.slice(0, 3).map((r) => artistTop(r.id, 5).catch(() => [])));
    relTops.forEach((tracks, j) => tracks.forEach((t, i) => out.push({ rec: catRec(t), c: { artist: t.artist, title: t.title, popularity: 0.8 - i / 8, related: [{ to: a.name, strength: 1 - j * 0.12 }] } })));
  }));
  const genre = await deezerGenre(genreNames);
  const chart = genre ? await charts(genre.id).catch(() => null) : !seedArtists.length ? await charts("0").catch(() => null) : null;
  chart?.tracks.slice(0, 25).forEach((t, i) => out.push({ rec: catRec(t), c: { artist: t.artist, title: t.title, genre: genre?.name ?? null, popularity: 1 - i / 30 } }));
  return out;
}

async function libraryCandidates(): Promise<Cand[]> {
  const pool = await db.musicTrack.findMany({ where: { status: "ready" }, take: 4000, orderBy: { createdAt: "desc" } });
  return pool.map((t) => ({
    rec: { key: `lib:${t.id}`, input: { trackId: t.id }, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, artworkUrl: coverUrl(t.coverHash), trackId: t.id, reason: "" },
    c: { artist: t.artist, title: t.title, genre: t.genre, year: t.year },
  }));
}

function withTimeout<T>(p: Promise<T[]>, ms?: number): Promise<T[]> {
  if (!ms) return p;
  p.catch(() => {});
  return Promise.race([p, new Promise<T[]>((r) => setTimeout(() => r([]), ms).unref?.())]);
}

export interface RecommendOptions {
  n: number;
  /** Songs that define the context (a playlist, the end of the queue). Their artists seed the search. */
  context?: { artist: string; title?: string }[];
  /** How much the context counts (and how much the overall taste still does). */
  contextWeight?: number;
  tasteWeight?: number;
  /** Song keys (songKey) to leave out, e.g. what's already in the playlist. */
  exclude?: Set<string>;
  library: boolean;
  catalog: boolean;
  perArtist?: number;
  /** Give up on the catalogue after this long (the lookups keep going and are cached for the next call). */
  catalogTimeoutMs?: number;
}

/** Ranked, diverse recommendations for a profile. Library songs win over the same song from the catalogue. */
export async function recommend(profileId: string, o: RecommendOptions): Promise<Rec[]> {
  const taste = await musicTasteOf(profileId);
  const ctx = o.context?.length ? contextOf(o.context, o.contextWeight ?? 1, o.tasteWeight ?? 1) : undefined;
  const seeds = [...new Set([...[...(ctx?.artists.entries() ?? [])].sort((a, b) => b[1] - a[1]).map(([n]) => n), ...(ctx ? [] : taste.artists.map((a) => a.name))])].slice(0, 4);
  if (ctx && seeds.length < 4) for (const a of taste.artists) { if (seeds.length >= 4) break; if (!seeds.some((s) => artistKey(s) === a.key) && (o.tasteWeight ?? 1) >= 0.5) seeds.push(a.name); }

  const [lib, cat] = await Promise.all([
    o.library ? libraryCandidates() : Promise.resolve([]),
    o.catalog && (await onlineEnabled()) ? withTimeout(catalogCandidates(seeds, taste.genres.map((x) => x.name)), o.catalogTimeoutMs) : Promise.resolve([]),
  ]);
  // Library copies replace catalogue entries of the same song; related-artist links found online also help library songs.
  const relatedBy = new Map<string, { to: string; strength: number }[]>();
  for (const x of cat) if (x.c.related?.length) relatedBy.set(artistKey(x.c.artist), x.c.related);
  const byKey = new Map<string, Cand>();
  for (const x of [...lib, ...cat]) {
    const k = songKey(x.c.artist, x.c.title);
    if (o.exclude?.has(k)) continue;
    const prev = byKey.get(k);
    if (prev) { if (!prev.c.popularity && x.c.popularity) prev.c.popularity = x.c.popularity; continue; }
    if (!x.c.related) x.c.related = relatedBy.get(artistKey(x.c.artist));
    byKey.set(k, x);
  }
  const scored = scoreTracks(taste, [...byKey.values()].map((x) => ({ item: x.rec, c: x.c })), ctx);
  return pickDiverse(scored, o.n, { perArtist: o.perArtist ?? 2 }).map((m) => ({ ...m.item, reason: m.reason }));
}

/** A readable summary for the "Your taste" page. */
export async function tasteSummary(profileId: string) {
  const t = await musicTasteOf(profileId);
  return {
    artists: t.artists.slice(0, 20).map((a) => ({ name: a.name, score: Math.round(a.score * 100) / 100 })),
    genres: t.genres.slice(0, 10).map((x) => ({ name: x.name, score: Math.round(x.score * 100) / 100 })),
    decades: t.decades.slice(0, 6),
    learned: Math.round(t.learned * 100) / 100,
    signals: t.signals,
    picks: t.picks,
  };
}
