import "server-only";
import { db } from "../db";
import { coverUrl, toTrackDTO, type TrackDTO } from "./catalog";
import { shuffleInPlace } from "./util";

const DAY = 86400_000;

interface Taste { artists: Map<string, number>; genres: Map<string, number>; recent: Set<string>; plays: number }

/** Affinity from the profile's play history: finished plays count fully, skips barely. Newer plays weigh more. */
export async function tasteOf(profileId: string): Promise<Taste> {
  const plays = await db.musicPlay.findMany({ where: { profileId, playedAt: { gt: new Date(Date.now() - 120 * DAY) } }, orderBy: { playedAt: "desc" }, take: 800 });
  const artists = new Map<string, number>(), genres = new Map<string, number>(), recent = new Set<string>();
  plays.forEach((p, i) => {
    const w = (p.completed ? 1 : p.playedSec >= 30 ? 0.5 : 0.1) * (1 - Math.min(0.7, (Date.now() - p.playedAt.getTime()) / (120 * DAY)));
    artists.set(p.artist, (artists.get(p.artist) ?? 0) + w);
    if (p.genre) genres.set(p.genre, (genres.get(p.genre) ?? 0) + w);
    if (p.trackId && i < 40) recent.add(p.trackId);
  });
  return { artists, genres, recent, plays: plays.length };
}

/** Ranked local tracks for a profile (affinity + a little randomness, at most 3 per artist). */
export async function recommendLocal(profileId: string, n: number, exclude: Set<string> = new Set()): Promise<TrackDTO[]> {
  const taste = await tasteOf(profileId);
  const pool = await db.musicTrack.findMany({ where: { status: "ready" }, take: 4000, orderBy: { createdAt: "desc" } });
  const scored = pool.filter((t) => !exclude.has(t.id) && !taste.recent.has(t.id)).map((t) => ({
    t, s: 2 * Math.log1p(taste.artists.get(t.artist) ?? 0) + Math.log1p(taste.genres.get(t.genre ?? "") ?? 0) + Math.random() * (taste.plays ? 0.8 : 3),
  }));
  scored.sort((a, b) => b.s - a.s);
  const perArtist = new Map<string, number>();
  const out: TrackDTO[] = [];
  for (const { t } of scored) {
    const c = perArtist.get(t.artist) ?? 0;
    if (c >= 3) continue;
    perArtist.set(t.artist, c + 1);
    out.push(toTrackDTO(t));
    if (out.length >= n) break;
  }
  return out;
}

/** "Radio": tracks like the seed (same artist, same genre and era), shuffled. Seed is a local track id. */
export async function radioFromTrack(seedId: string, n: number): Promise<TrackDTO[]> {
  const seed = await db.musicTrack.findUnique({ where: { id: seedId } });
  if (!seed) return [];
  const [sameArtist, sameGenre] = await Promise.all([
    db.musicTrack.findMany({ where: { status: "ready", artist: seed.artist, id: { not: seed.id } }, take: 60 }),
    seed.genre ? db.musicTrack.findMany({ where: { status: "ready", genre: seed.genre, id: { not: seed.id } }, take: 400 }) : Promise.resolve([]),
  ]);
  const era = (y: number | null) => (seed.year && y ? Math.abs(y - seed.year) <= 8 : true);
  const pool = new Map<string, (typeof sameArtist)[number]>();
  for (const t of shuffleInPlace([...sameArtist]).slice(0, Math.ceil(n / 3))) pool.set(t.id, t);
  for (const t of shuffleInPlace(sameGenre.filter((t) => era(t.year)))) { if (pool.size >= n) break; pool.set(t.id, t); }
  if (pool.size < n) for (const t of shuffleInPlace(await db.musicTrack.findMany({ where: { status: "ready", id: { not: seed.id } }, take: 200 }))) { if (pool.size >= n) break; pool.set(t.id, t); }
  return shuffleInPlace([...pool.values()]).map(toTrackDTO);
}

export async function homeSections(profileId: string) {
  const [made, recentPlays, added] = await Promise.all([
    recommendLocal(profileId, 20),
    db.musicPlay.findMany({ where: { profileId, trackId: { not: null } }, orderBy: { playedAt: "desc" }, take: 60, include: undefined }),
    db.musicTrack.findMany({ where: { status: "ready" }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const ids = [...new Set(recentPlays.map((p) => p.trackId!))].slice(0, 20);
  const tracks = await db.musicTrack.findMany({ where: { id: { in: ids }, status: "ready" } });
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const recent = ids.map((i) => byId.get(i)).filter(Boolean).map((t) => toTrackDTO(t!));
  return { madeForYou: made, recentlyPlayed: recent, recentlyAdded: added.map(toTrackDTO) };
}

export { coverUrl };
