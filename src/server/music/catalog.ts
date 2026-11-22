import "server-only";
import { db } from "../db";
import type { MusicTrack } from "@/generated/prisma/client";
import { baseTitle, normalize } from "@shared/music-match";

export interface TrackDTO {
  id: string; title: string; artist: string; album: string | null; albumKey: string; durationSec: number; coverUrl: string | null;
  genre: string | null; year: number | null; trackNo: number | null; codec: string | null; local: true;
}

export const coverUrl = (hash: string | null) => (hash ? `/api/music/cover/${hash}` : null);
export const toTrackDTO = (t: MusicTrack): TrackDTO => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, albumKey: t.albumKey, durationSec: t.durationSec, coverUrl: coverUrl(t.coverHash),
  genre: t.genre, year: t.year, trackNo: t.trackNo, codec: t.codec, local: true,
});

/** Case-insensitive `contains` that works on every supported database (SQLite/MySQL already are; PostgreSQL needs `mode`). */
const insensitive = /^postgres/.test(process.env.DATABASE_URL ?? "");
export const like = (q: string) => (insensitive ? { contains: q, mode: "insensitive" as const } : { contains: q });

const ready = { status: "ready" } as const;
const ORDER = [{ artist: "asc" }, { album: "asc" }, { discNo: "asc" }, { trackNo: "asc" }, { title: "asc" }] as const;

export async function listTracks(o: { q?: string; artist?: string; albumKey?: string; genre?: string; take?: number; skip?: number; recent?: boolean }) {
  const where = {
    ...ready,
    ...(o.artist ? { artist: o.artist } : {}),
    ...(o.albumKey ? { albumKey: o.albumKey } : {}),
    ...(o.genre ? { genre: o.genre } : {}),
    ...(o.q ? { OR: [{ title: like(o.q) }, { artist: like(o.q) }, { album: like(o.q) }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db.musicTrack.findMany({ where, orderBy: o.recent ? { createdAt: "desc" } : [...ORDER], take: Math.min(o.take ?? 100, 500), skip: o.skip ?? 0 }),
    db.musicTrack.count({ where }),
  ]);
  return { tracks: rows.map(toTrackDTO), total };
}

export interface AlbumDTO { albumKey: string; album: string; artist: string; year: number | null; tracks: number; coverUrl: string | null }

export async function listAlbums(o: { q?: string; artist?: string; take?: number; skip?: number } = {}): Promise<AlbumDTO[]> {
  const rows = await db.musicTrack.groupBy({
    by: ["albumKey"],
    where: { ...ready, album: { not: null }, ...(o.artist ? { artist: o.artist } : {}), ...(o.q ? { OR: [{ album: like(o.q) }, { artist: like(o.q) }] } : {}) },
    _count: { _all: true },
    _min: { album: true, albumArtist: true, artist: true, year: true, coverHash: true },
    orderBy: { _min: { album: "asc" } },
    take: Math.min(o.take ?? 120, 500),
    skip: o.skip ?? 0,
  });
  return rows.map((r) => ({ albumKey: r.albumKey, album: r._min.album ?? "Unknown album", artist: r._min.albumArtist ?? r._min.artist ?? "Unknown artist", year: r._min.year, tracks: r._count._all, coverUrl: coverUrl(r._min.coverHash) }));
}

export interface ArtistDTO { artist: string; tracks: number; coverUrl: string | null }

export async function listArtists(o: { q?: string; take?: number; skip?: number } = {}): Promise<ArtistDTO[]> {
  const rows = await db.musicTrack.groupBy({
    by: ["artist"], where: { ...ready, ...(o.q ? { artist: like(o.q) } : {}) }, _count: { _all: true }, _min: { coverHash: true }, orderBy: { artist: "asc" }, take: Math.min(o.take ?? 200, 500), skip: o.skip ?? 0,
  });
  return rows.map((r) => ({ artist: r.artist, tracks: r._count._all, coverUrl: coverUrl(r._min.coverHash) }));
}

export async function getAlbum(albumKey: string) {
  const tracks = await db.musicTrack.findMany({ where: { albumKey, ...ready }, orderBy: [{ discNo: "asc" }, { trackNo: "asc" }, { title: "asc" }] });
  if (!tracks.length) return null;
  const t0 = tracks[0];
  return {
    albumKey, album: t0.album ?? t0.title, artist: t0.albumArtist ?? t0.artist, year: t0.year, genre: t0.genre, coverUrl: coverUrl(tracks.find((t) => t.coverHash)?.coverHash ?? null),
    durationSec: tracks.reduce((a, t) => a + t.durationSec, 0), tracks: tracks.map(toTrackDTO),
  };
}

export async function libraryStats() {
  const [tracks, albums, artists, missing, bytes] = await Promise.all([
    db.musicTrack.count({ where: ready }),
    db.musicTrack.groupBy({ by: ["albumKey"], where: ready }).then((r) => r.length),
    db.musicTrack.groupBy({ by: ["artist"], where: ready }).then((r) => r.length),
    db.musicTrack.count({ where: { status: "missing" } }),
    db.musicTrack.aggregate({ where: ready, _sum: { size: true, durationSec: true } }),
  ]);
  return { tracks, albums, artists, missing, bytes: Number(bytes._sum.size ?? 0), durationSec: bytes._sum.durationSec ?? 0 };
}

// ---------- matching imported / external tracks to the local library ----------
type Row = { id: string; title: string; artist: string; albumArtist: string | null; durationSec: number; coverHash: string | null };
let index: { at: number; byTitle: Map<string, Row[]> } | null = null;
export const invalidateMatchIndex = () => { index = null; };

async function getIndex() {
  if (index && Date.now() - index.at < 60_000) return index;
  const rows = await db.musicTrack.findMany({ where: ready, select: { id: true, title: true, artist: true, albumArtist: true, durationSec: true, coverHash: true } });
  const byTitle = new Map<string, Row[]>();
  for (const r of rows) { const k = normalize(baseTitle(r.title)); const a = byTitle.get(k); if (a) a.push(r); else byTitle.set(k, [r]); }
  return (index = { at: Date.now(), byTitle });
}

const artistTokens = (s: string) => new Set(normalize(s).split(" ").filter((t) => t.length > 1 && !["feat", "ft", "and", "the", "with"].includes(t)));

/** Best local track for a title/artist (and duration, when known), or null. */
export async function findLocalMatch(title: string, artist: string, durationSec?: number): Promise<Row | null> {
  const cands = (await getIndex()).byTitle.get(normalize(baseTitle(title)));
  if (!cands?.length) return null;
  const want = artistTokens(artist);
  let best: { r: Row; s: number } | null = null;
  for (const r of cands) {
    const have = artistTokens(`${r.artist} ${r.albumArtist ?? ""}`);
    const overlap = [...want].filter((t) => have.has(t)).length;
    if (want.size && !overlap) continue;
    let s = want.size ? overlap / want.size : 0.5;
    if (durationSec && r.durationSec) { const d = Math.abs(durationSec - r.durationSec); if (d > 8) continue; s += d <= 3 ? 0.5 : 0.1; }
    if (!best || s > best.s) best = { r, s };
  }
  return best?.r ?? null;
}
