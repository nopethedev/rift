import "server-only";
import { db } from "../db";
import { HttpError } from "../api";
import { songKey, type SavedDTO } from "@/lib/music-types";
import { coverUrl, findLocalMatch, toTrackDTO } from "./catalog";
import type { ItemInput } from "./queue";
import { seal, unseal } from "./seal";

type Row = NonNullable<Awaited<ReturnType<typeof db.musicSaved.findFirst>>>;

async function toDTOs(rows: Row[]): Promise<SavedDTO[]> {
  const ids = rows.flatMap((r) => (r.trackId ? [r.trackId] : []));
  const tracks = new Map((await db.musicTrack.findMany({ where: { id: { in: ids }, status: "ready" } })).map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = r.trackId ? tracks.get(r.trackId) : undefined;
    return {
      id: r.id, key: r.extKey, title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec, artworkUrl: r.artworkUrl ?? (t ? coverUrl(t.coverHash) : null), trackId: t ? r.trackId : null,
      match: t ? "local" : r.candidate ? "ondemand" : "unmatched", createdAt: r.createdAt.toISOString(), track: t ? toTrackDTO(t) : null,
    };
  });
}

export async function listSaved(profileId: string): Promise<SavedDTO[]> {
  return toDTOs(await db.musicSaved.findMany({ where: { profileId }, orderBy: { createdAt: "desc" }, take: 5000 }));
}
export async function savedKeys(profileId: string): Promise<string[]> {
  return (await db.musicSaved.findMany({ where: { profileId }, select: { extKey: true } })).map((r) => r.extKey);
}

/** Keep a song. A library file is stored by id; anything else stays a reference (matched to the library when possible). */
export async function saveSong(profileId: string, input: ItemInput): Promise<SavedDTO> {
  let data: { title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; trackId: string | null; candidate: string | null };
  if ("trackId" in input) {
    const t = await db.musicTrack.findFirst({ where: { id: input.trackId, status: "ready" } });
    if (!t) throw new HttpError(404, "Track not found");
    data = { title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, artworkUrl: null, trackId: t.id, candidate: null };
  } else {
    const local = await findLocalMatch(input.title, input.artist, input.durationSec ?? undefined);
    const cand = unseal(input.candidate);
    data = { title: input.title, artist: input.artist, album: input.album ?? null, durationSec: input.durationSec ?? null, artworkUrl: input.artworkUrl ?? null, trackId: local?.id ?? null, candidate: cand ? JSON.stringify(cand) : null };
  }
  const extKey = songKey(data.artist, data.title);
  const row = await db.musicSaved.upsert({ where: { profileId_extKey: { profileId, extKey } }, create: { profileId, extKey, ...data }, update: {} });
  return (await toDTOs([row]))[0];
}

export async function unsaveSong(profileId: string, key: string) {
  await db.musicSaved.deleteMany({ where: { profileId, extKey: key } });
}

/** The user matches a saved song by hand: to a library track, or to an on-demand result they picked. */
export async function matchSaved(profileId: string, id: string, pick: { trackId: string } | { candidate: unknown } | { clear: true }) {
  const row = await db.musicSaved.findFirst({ where: { id, profileId } });
  if (!row) throw new HttpError(404, "Song not found");
  await db.musicSaved.update({ where: { id }, data: await matchPatch(pick) });
}

/** Shared by saved songs and playlist items. */
export async function matchPatch(pick: { trackId: string } | { candidate: unknown } | { clear: true }): Promise<{ trackId: string | null; candidate: string | null }> {
  if ("clear" in pick) return { trackId: null, candidate: null };
  if ("trackId" in pick) {
    if (!(await db.musicTrack.findFirst({ where: { id: pick.trackId, status: "ready" }, select: { id: true } }))) throw new HttpError(404, "Track not found");
    return { trackId: pick.trackId, candidate: null };
  }
  const c = unseal(pick.candidate);
  if (!c) throw new HttpError(400, "That search result has expired or is not valid. Search again.");
  return { trackId: null, candidate: JSON.stringify(seal(c)) };
}

/** Queue inputs for a saved song (library file, pinned source, or title/artist to resolve). */
export const savedInput = (r: { trackId: string | null; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; candidate: string | null }): ItemInput =>
  r.trackId ? { trackId: r.trackId } : { title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec, artworkUrl: r.artworkUrl, candidate: r.candidate ? JSON.parse(r.candidate) : null };
