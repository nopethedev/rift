import "server-only";
// Metadata from public, keyless APIs: Deezer (charts, releases, artists, albums, covers), iTunes (cover fallback) and
// Wikipedia (artist bios). Metadata only: no audio ever comes from here. Everything is cached in memory and rate limited.
import { getSettings } from "../settings";
import { normalize } from "@shared/music-match";
import type { ArtistProfile, CatAlbum, CatArtist, CatTrack, Feed, Shelf } from "@/lib/music-types";

const base = (envName: string, def: string) => (process.env[envName] || def).replace(/\/$/, "");
const DZ = () => base("DEEZER_API_URL", "https://api.deezer.com");
const ITUNES = () => base("ITUNES_API_URL", "https://itunes.apple.com");
const WIKI = () => base("WIKIPEDIA_API_URL", "https://en.wikipedia.org");

export class OnlineError extends Error {}

export async function onlineEnabled(): Promise<boolean> {
  return (await getSettings()).musicMetadata;
}

// ---------- fetch with cache, spacing and timeout ----------
const MAX_CACHE = 600;
const g = globalThis as unknown as { __riftOnline?: { cache: Map<string, { at: number; v: unknown }>; inflight: Map<string, Promise<unknown>>; next: number } };
const st = (g.__riftOnline ??= { cache: new Map(), inflight: new Map(), next: 0 });
export const clearOnlineCache = () => { st.cache.clear(); st.inflight.clear(); };

/** Deezer allows ~50 requests / 5 s: space requests ~120 ms apart. */
async function gate() {
  const now = Date.now();
  const at = Math.max(now, st.next);
  st.next = at + 120;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** `reject` returns an error message for a 200 answer that must not be cached (e.g. Deezer's in-body quota error). */
async function getJson<T>(url: string, ttlMs: number, headers: Record<string, string> = {}, reject?: (v: T) => string | null): Promise<T> {
  const hit = st.cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  let p = st.inflight.get(url) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      await gate();
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Rift/1.0 (self-hosted media server)", ...headers }, signal: AbortSignal.timeout(9000) }).catch((e: Error) => { throw new OnlineError(`Could not reach ${new URL(url).host}: ${e.cause instanceof Error ? e.cause.message : e.message}`); });
      if (!res.ok) throw new OnlineError(`${new URL(url).host} answered ${res.status}`);
      const v = (await res.json().catch(() => { throw new OnlineError(`${new URL(url).host} sent invalid JSON`); })) as T;
      const bad = reject?.(v);
      if (bad) throw new OnlineError(bad);
      if (st.cache.size >= MAX_CACHE) st.cache.delete(st.cache.keys().next().value!);
      st.cache.set(url, { at: Date.now(), v });
      return v;
    })().finally(() => st.inflight.delete(url));
    st.inflight.set(url, p);
  }
  return p;
}

interface DzErr { error?: { type?: string; message?: string; code?: number } }
const dzError = (v: DzErr) => (v && typeof v === "object" && v.error ? `Deezer: ${v.error.message ?? v.error.type ?? "error"}` : null);
/**
 * Deezer answers errors with HTTP 200 and an `error` body. Those are never cached (a cached "Quota limit exceeded"
 * used to blank an artist's releases for hours); the quota error (code 4) is retried after a short pause.
 */
async function dz<T>(path: string, ttlMs = 30 * 60_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJson<T & DzErr>(`${DZ()}${path}`, ttlMs, {}, dzError);
    } catch (e) {
      if (attempt >= 2 || !(e instanceof OnlineError) || !/quota/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
}
const enc = encodeURIComponent;
const HOUR = 3600_000;

// ---------- mapping ----------
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Deezer serves a generic placeholder when it has no picture: treat those as missing. */
const pic = (o: Raw | undefined, ...keys: string[]): string | null => {
  for (const k of keys) { const u = o?.[k]; if (typeof u === "string" && u && !/\/(artist|cover|playlist)\/\/|\/images\/(artist|cover)\/\d|\/images\/\w+\/\//.test(u)) return u; }
  return null;
};
const id = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export const mapTrack = (d: Raw, album?: { id: string | null; title: string | null; art: string | null }): CatTrack => ({
  id: String(d.id), title: String(d.title_short && d.title && d.title.length > d.title_short.length + 40 ? d.title_short : d.title ?? ""), artist: String(d.artist?.name ?? ""), artistId: id(d.artist?.id),
  album: album?.title ?? d.album?.title ?? null, albumId: album?.id ?? id(d.album?.id), durationSec: Number(d.duration) || 0,
  artworkUrl: album?.art ?? pic(d.album, "cover_xl", "cover_big", "cover_medium"), explicit: d.explicit_lyrics === true ? true : undefined,
});
const KIND: Record<string, CatAlbum["kind"]> = { album: "album", single: "single", ep: "ep", compile: "compilation" };
export const mapAlbum = (d: Raw): CatAlbum => ({
  id: String(d.id), title: String(d.title ?? ""), artist: String(d.artist?.name ?? ""), artistId: id(d.artist?.id), artworkUrl: pic(d, "cover_xl", "cover_big", "cover_medium"),
  year: d.release_date ? Number(String(d.release_date).slice(0, 4)) || null : null, kind: KIND[String(d.record_type ?? "").toLowerCase()] ?? null, tracks: typeof d.nb_tracks === "number" ? d.nb_tracks : null,
});
export const mapArtist = (d: Raw): CatArtist => ({ id: String(d.id), name: String(d.name ?? ""), pictureUrl: pic(d, "picture_xl", "picture_big", "picture_medium"), fans: typeof d.nb_fan === "number" ? d.nb_fan : null });
const list = (v: Raw | undefined): Raw[] => (Array.isArray(v?.data) ? v!.data : []);
const playable = (t: Raw) => t && t.id && t.title && t.artist?.name;

// ---------- charts, releases, genres ----------
export async function charts(genreId = "0") {
  const r = await dz<Raw>(`/chart/${enc(genreId)}`, HOUR);
  return {
    tracks: list(r.tracks).filter(playable).map((t) => mapTrack(t)),
    albums: list(r.albums).map(mapAlbum),
    artists: list(r.artists).map(mapArtist),
  };
}
export async function newReleases(limit = 30): Promise<CatAlbum[]> {
  const r = await dz<Raw>(`/editorial/0/releases?limit=${limit}`, HOUR);
  return list(r).map(mapAlbum);
}
export async function genres(): Promise<{ id: string; name: string; pictureUrl: string | null }[]> {
  const r = await dz<Raw>("/genre", 24 * HOUR);
  return list(r).filter((x) => String(x.id) !== "0").map((x) => ({ id: String(x.id), name: String(x.name), pictureUrl: pic(x, "picture_xl", "picture_big", "picture_medium") }));
}

// ---------- search ----------
export async function searchCatalog(q: string) {
  const [artists, albums, tracks] = await Promise.all([
    dz<Raw>(`/search/artist?q=${enc(q)}&limit=8`, 10 * 60_000).then((r) => list(r).map(mapArtist)).catch(() => [] as CatArtist[]),
    dz<Raw>(`/search/album?q=${enc(q)}&limit=12`, 10 * 60_000).then((r) => list(r).map(mapAlbum)).catch(() => [] as CatAlbum[]),
    dz<Raw>(`/search/track?q=${enc(q)}&limit=15`, 10 * 60_000).then((r) => list(r).filter(playable).map((t) => mapTrack(t))).catch(() => [] as CatTrack[]),
  ]);
  return { artists, albums, tracks };
}

// ---------- artists ----------
/** Best Deezer artist for a name: exact (normalised) match wins; otherwise only a very close, popular result. */
export async function findArtist(name: string): Promise<CatArtist | null> {
  const r = await dz<Raw>(`/search/artist?q=${enc(`"${name}"`)}&limit=6`, 6 * HOUR).catch(() => null);
  const cands = list(r ?? undefined).map(mapArtist);
  const n = normalize(name);
  const exact = cands.filter((c) => normalize(c.name) === n).sort((a, b) => (b.fans ?? 0) - (a.fans ?? 0));
  return exact[0] ?? null;
}

const MUSICIAN = /\b(band|singer|rapper|musician|songwriter|composer|duo|group|dj|producer|vocalist|guitarist|pianist|violinist|drummer|artist|trio|quartet|orchestra|ensemble|hip hop|disc jockey)\b/i;
export async function artistBio(name: string): Promise<{ text: string; url: string | null } | null> {
  const title = name.trim().replace(/\s+/g, "_");
  const tryTitle = async (t: string) => {
    const r = await getJson<Raw>(`${WIKI()}/api/rest_v1/page/summary/${enc(t)}?redirect=true`, 24 * HOUR).catch(() => null);
    if (!r || r.type !== "standard" || typeof r.extract !== "string") return null;
    if (!MUSICIAN.test(`${r.description ?? ""} ${r.extract.slice(0, 400)}`)) return null; // e.g. a place or a person of the same name
    return { text: r.extract as string, url: (r.content_urls?.desktop?.page as string | undefined) ?? null };
  };
  return (await tryTitle(title)) ?? (await tryTitle(`${title}_(band)`)) ?? (await tryTitle(`${title}_(singer)`)) ?? (await tryTitle(`${title}_(musician)`));
}

/** Same song listed twice (single + album version): keep the first (= the more popular) one. */
const dedupeSongs = (tracks: CatTrack[]): CatTrack[] => { const seen = new Set<string>(); return tracks.filter((t) => { const k = `${normalize(t.title)}|${normalize(t.artist)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Every release of an artist (Deezer pages at 100). Falls back to an album search on the artist when the list fails. */
async function artistAlbums(artistId: string, name: string): Promise<{ albums: CatAlbum[]; error: string | null }> {
  const own = (x: Raw) => ({ ...x, artist: x.artist ?? { id: artistId, name } }); // the artist's album list omits the artist
  try {
    const out: Raw[] = [];
    for (let index = 0; index < 400; index += 100) {
      const r = await dz<Raw>(`/artist/${artistId}/albums?limit=100&index=${index}`, 6 * HOUR);
      const page = list(r);
      out.push(...page);
      if (page.length < 100 || (typeof r.total === "number" && out.length >= r.total)) break;
    }
    if (out.length) return { albums: out.map((x) => mapAlbum(own(x))), error: null };
  } catch (e) {
    const fallback = await searchArtistAlbums(artistId, name).catch(() => []);
    return { albums: fallback, error: fallback.length ? null : (e as Error).message };
  }
  return { albums: await searchArtistAlbums(artistId, name).catch(() => []), error: null };
}
async function searchArtistAlbums(artistId: string, name: string): Promise<CatAlbum[]> {
  if (!name) return [];
  const r = await dz<Raw>(`/search/album?q=${enc(`artist:"${name}"`)}&limit=100`, 6 * HOUR);
  return list(r).filter((x) => String(x.artist?.id ?? "") === artistId).map(mapAlbum);
}

export async function artistProfile(artistId: string): Promise<ArtistProfile> {
  if (!/^\d{1,12}$/.test(artistId)) throw new OnlineError("Bad artist id");
  const a = await dz<Raw>(`/artist/${artistId}`, 6 * HOUR);
  const name = String(a.name ?? "");
  const [top, disco, related, bio] = await Promise.all([
    dz<Raw>(`/artist/${artistId}/top?limit=100`, 6 * HOUR).then((r) => dedupeSongs(list(r).filter(playable).map((t) => mapTrack(t)))).catch(() => [] as CatTrack[]),
    artistAlbums(artistId, name),
    dz<Raw>(`/artist/${artistId}/related?limit=12`, 12 * HOUR).then((r) => list(r).map(mapArtist)).catch(() => [] as CatArtist[]),
    artistBio(name).catch(() => null),
  ]);
  // Newest first, one entry per title + kind (Deezer lists regional / deluxe duplicates; a single may share the album's name).
  const seen = new Set<string>();
  const uniq = disco.albums.filter((x) => { const k = `${normalize(x.title) || x.title.toLowerCase()}|${x.kind === "album" || x.kind === null ? "a" : x.kind}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
  return { artist: { ...mapArtist(a), albums: typeof a.nb_album === "number" ? a.nb_album : null }, bio, topTracks: top, albums: uniq, albumsError: disco.error, related };
}

export async function albumDetail(albumId: string): Promise<{ album: CatAlbum & { label: string | null; genres: string[]; durationSec: number }; tracks: CatTrack[] }> {
  if (!/^\d{1,12}$/.test(albumId)) throw new OnlineError("Bad album id");
  const a = await dz<Raw>(`/album/${albumId}`, 12 * HOUR);
  const meta = mapAlbum(a);
  const tracks = list(a.tracks).filter(playable).map((t) => mapTrack(t, { id: meta.id, title: meta.title, art: meta.artworkUrl }));
  return { album: { ...meta, label: a.label ?? null, genres: list(a.genres).map((x) => String(x.name)), durationSec: Number(a.duration) || tracks.reduce((s, t) => s + t.durationSec, 0) }, tracks };
}

// ---------- artwork lookup ----------
/** Cover for a song/album the library has no picture for. Deezer first, iTunes as a second opinion. */
export async function findAlbumArt(q: { artist: string; album?: string | null; title?: string }): Promise<string | null> {
  const artist = normalize(q.artist);
  const unknown = !artist || artist === "unknown artist";
  if (q.album) {
    const s = unknown ? q.album : `artist:"${q.artist}" album:"${q.album}"`;
    const r = await dz<Raw>(`/search/album?q=${enc(s)}&limit=6`, 24 * HOUR).catch(() => null);
    const want = normalize(q.album);
    const hit = list(r ?? undefined).find((x) => { const t = normalize(String(x.title)); return (t === want || t.startsWith(want) || want.startsWith(t)) && (unknown || normalize(String(x.artist?.name)).includes(artist) || artist.includes(normalize(String(x.artist?.name)))); });
    const u = pic(hit, "cover_xl", "cover_big", "cover_medium");
    if (u) return u;
  }
  if (q.title && !unknown) {
    const r = await dz<Raw>(`/search/track?q=${enc(`artist:"${q.artist}" track:"${q.title}"`)}&limit=5`, 24 * HOUR).catch(() => null);
    const want = normalize(q.title);
    const hit = list(r ?? undefined).find((x) => normalize(String(x.title)) === want || normalize(String(x.title_short ?? "")) === want);
    const u = pic(hit?.album, "cover_xl", "cover_big", "cover_medium");
    if (u) return u;
  }
  const term = [unknown ? "" : q.artist, q.album ?? q.title ?? ""].join(" ").trim();
  if (!term) return null;
  const r = await getJson<Raw>(`${ITUNES()}/search?term=${enc(term)}&entity=album&limit=5`, 24 * HOUR).catch(() => null);
  const want = normalize(q.album ?? q.title ?? "");
  const hit = (Array.isArray(r?.results) ? r!.results : []).find((x: Raw) => normalize(String(x.collectionName)).startsWith(want) && (unknown || normalize(String(x.artistName)).includes(artist) || artist.includes(normalize(String(x.artistName)))));
  return typeof hit?.artworkUrl100 === "string" ? hit.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, "/600x600bb.$2") : null;
}

// ---------- feed ----------
export interface Taste { artists: string[]; genres: string[] }

const GENRE_ALIAS: Record<string, string> = { "hip-hop": "rap/hip hop", "hip hop": "rap/hip hop", rap: "rap/hip hop", rnb: "r&b", "r&b": "r&b", "electronic": "electro", edm: "electro", dance: "dance", house: "electro", techno: "electro", "alternative": "alternative", indie: "alternative", metal: "metal", "heavy metal": "metal", country: "country", jazz: "jazz", classical: "classical", reggae: "reggae", latin: "latin music", pop: "pop", rock: "rock", soul: "soul & funk", funk: "soul & funk" };

/** Home shelves: charts + new releases + "because you listened to …" built from the profile's play history. */
export async function buildFeed(taste: Taste): Promise<Feed> {
  if (!(await onlineEnabled())) return { enabled: false, shelves: [], genres: [] };
  const errors: string[] = [];
  const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch((e: Error) => { errors.push(e.message); return fallback; });
  const [chart, releases, genreList] = await Promise.all([
    safe(charts("0"), { tracks: [], albums: [], artists: [] }),
    safe(newReleases(30), [] as CatAlbum[]),
    safe(genres(), [] as Awaited<ReturnType<typeof genres>>),
  ]);
  const shelves: Shelf[] = [];

  // Personal shelves (best effort, never fail the feed).
  const matched = (await Promise.all(taste.artists.slice(0, 3).map((a) => findArtist(a).catch(() => null)))).filter((a): a is CatArtist => !!a);
  for (const a of matched.slice(0, 2)) {
    const [rel, top] = await Promise.all([dz<Raw>(`/artist/${a.id}/related?limit=12`, 12 * HOUR).then((r) => list(r).map(mapArtist)).catch(() => [] as CatArtist[]), dz<Raw>(`/artist/${a.id}/top?limit=12`, 6 * HOUR).then((r) => list(r).filter(playable).map((t) => mapTrack(t))).catch(() => [] as CatTrack[])]);
    if (top.length) shelves.push({ id: `top-${a.id}`, title: `More from ${a.name}`, subtitle: "Because you listen to them", tracks: top, href: `/music/artists/${enc(a.name)}?id=${a.id}` });
    if (rel.length) shelves.push({ id: `rel-${a.id}`, title: `Fans of ${a.name} also like`, artists: rel });
  }
  const gname = taste.genres.map((x) => GENRE_ALIAS[x.toLowerCase()] ?? x.toLowerCase()).find((x) => genreList.some((gx) => gx.name.toLowerCase() === x));
  const gmatch = gname ? genreList.find((x) => x.name.toLowerCase() === gname) : undefined;
  if (gmatch) {
    const gc = await charts(gmatch.id).catch(() => null);
    if (gc?.tracks.length) shelves.push({ id: `genre-${gmatch.id}`, title: `Top ${gmatch.name}`, subtitle: "Your favourite genre", tracks: gc.tracks.slice(0, 20), href: `/music/genre/${gmatch.id}` });
  }

  if (chart.tracks.length) shelves.push({ id: "trending", title: "Trending now", subtitle: "Most played right now", tracks: chart.tracks.slice(0, 20) });
  if (releases.length) shelves.push({ id: "releases", title: "New releases", albums: releases });
  if (chart.artists.length) shelves.push({ id: "artists", title: "Popular artists", artists: chart.artists });
  if (chart.albums.length) shelves.push({ id: "albums", title: "Top albums", albums: chart.albums });
  return { enabled: true, shelves, genres: genreList, error: !shelves.length && errors.length ? errors[0] : undefined };
}
