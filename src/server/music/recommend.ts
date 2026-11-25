import "server-only";
import { db } from "../db";
import { coverUrl, toTrackDTO, type TrackDTO } from "./catalog";
import { shuffleInPlace } from "./util";
import { recommend } from "./taste";


/** Ranked library tracks for a profile, from the taste profile (src/lib/music-taste.ts): at most 3 per artist. */
export async function recommendLocal(profileId: string, n: number, exclude: Set<string> = new Set()): Promise<TrackDTO[]> {
  const recs = await recommend(profileId, { n: n + exclude.size, library: true, catalog: false, perArtist: 3 });
  const ids = recs.flatMap((r) => (r.trackId && !exclude.has(r.trackId) ? [r.trackId] : [])).slice(0, n);
  const byId = new Map((await db.musicTrack.findMany({ where: { id: { in: ids } } })).map((t) => [t.id, t]));
  return ids.flatMap((id) => (byId.has(id) ? [toTrackDTO(byId.get(id)!)] : []));
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
