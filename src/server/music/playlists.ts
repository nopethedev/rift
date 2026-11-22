import "server-only";
import { db } from "../db";
import { HttpError } from "../api";
import { getSettings } from "../settings";
import type { MusicPlaylistItem, MusicTrack } from "@/generated/prisma/client";
import type { Candidate } from "@shared/music-protocol";
import { coverUrl, findLocalMatch, toTrackDTO, type TrackDTO } from "./catalog";
import { musicMode, toWorkerConfig } from "./config";
import { fetchSpotify, SpotifyError, type ImportedPlaylist } from "./spotify";
import type { ItemInput } from "./queue";
import { musicWorker } from "./worker";

export type Availability = "local" | "ondemand" | "unavailable";
export interface PlaylistItemDTO {
  id: string; position: number; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null;
  trackId: string | null; availability: Availability | null; availabilityNote: string | null; track: TrackDTO | null;
}
export interface PlaylistDTO {
  id: string; name: string; description: string | null; source: string; sourceUrl: string | null; artworkUrl: string | null; lastSyncedAt: string | null; updatedAt: string;
  count: number; unavailable: number;
}

const itemDTO = (i: MusicPlaylistItem & { track: MusicTrack | null }): PlaylistItemDTO => ({
  id: i.id, position: i.position, title: i.title, artist: i.artist, album: i.album, durationSec: i.durationSec, artworkUrl: i.artworkUrl ?? (i.track ? coverUrl(i.track.coverHash) : null),
  trackId: i.trackId, availability: (i.availability as Availability | null) ?? (i.trackId ? "local" : null), availabilityNote: i.availabilityNote, track: i.track ? toTrackDTO(i.track) : null,
});

async function owned(profileId: string, id: string) {
  const p = await db.musicPlaylist.findFirst({ where: { id, profileId } });
  if (!p) throw new HttpError(404, "Playlist not found");
  return p;
}

export async function listPlaylists(profileId: string): Promise<PlaylistDTO[]> {
  const ps = await db.musicPlaylist.findMany({ where: { profileId }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { items: true } } } });
  const bad = await db.musicPlaylistItem.groupBy({ by: ["playlistId"], where: { playlist: { profileId }, availability: "unavailable" }, _count: { _all: true } });
  const badBy = new Map(bad.map((b) => [b.playlistId, b._count._all]));
  return ps.map((p) => ({ id: p.id, name: p.name, description: p.description, source: p.source, sourceUrl: p.sourceUrl, artworkUrl: p.artworkUrl, lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null, updatedAt: p.updatedAt.toISOString(), count: p._count.items, unavailable: badBy.get(p.id) ?? 0 }));
}

export async function getPlaylist(profileId: string, id: string) {
  const p = await owned(profileId, id);
  const items = await db.musicPlaylistItem.findMany({ where: { playlistId: id }, orderBy: { position: "asc" }, include: { track: true } });
  const dto = items.map(itemDTO);
  return {
    playlist: { id: p.id, name: p.name, description: p.description, source: p.source, sourceUrl: p.sourceUrl, artworkUrl: p.artworkUrl ?? dto.find((i) => i.artworkUrl)?.artworkUrl ?? null, lastSyncedAt: p.lastSyncedAt?.toISOString() ?? null, updatedAt: p.updatedAt.toISOString(), count: dto.length, unavailable: dto.filter((i) => i.availability === "unavailable").length } satisfies PlaylistDTO,
    items: dto,
    check: checkStatus(id),
  };
}

export async function createPlaylist(profileId: string, name: string, description?: string) {
  const p = await db.musicPlaylist.create({ data: { profileId, name: name.trim().slice(0, 120), description: description?.slice(0, 500) } });
  return p.id;
}
export async function updatePlaylist(profileId: string, id: string, d: { name?: string; description?: string }) {
  await owned(profileId, id);
  await db.musicPlaylist.update({ where: { id }, data: { ...(d.name ? { name: d.name.trim().slice(0, 120) } : {}), ...(d.description !== undefined ? { description: d.description.slice(0, 500) } : {}) } });
}
export async function deletePlaylist(profileId: string, id: string) {
  await owned(profileId, id);
  await db.musicPlaylist.delete({ where: { id } });
}

export async function addToPlaylist(profileId: string, id: string, inputs: ItemInput[]) {
  await owned(profileId, id);
  const last = await db.musicPlaylistItem.findFirst({ where: { playlistId: id }, orderBy: { position: "desc" } });
  let pos = (last?.position ?? -1) + 1;
  const ids = inputs.flatMap((i) => ("trackId" in i ? [i.trackId] : []));
  const tracks = new Map((await db.musicTrack.findMany({ where: { id: { in: ids }, status: "ready" } })).map((t) => [t.id, t]));
  for (const i of inputs) {
    if ("trackId" in i) {
      const t = tracks.get(i.trackId);
      if (t) await db.musicPlaylistItem.create({ data: { playlistId: id, position: pos++, trackId: t.id, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, availability: "local" } });
    } else {
      await db.musicPlaylistItem.create({ data: { playlistId: id, position: pos++, title: i.title, artist: i.artist, album: i.album ?? null, durationSec: i.durationSec ?? null, artworkUrl: i.artworkUrl ?? null, candidate: i.candidate ? JSON.stringify(i.candidate) : null, availability: i.candidate ? "ondemand" : null } });
    }
  }
  await db.musicPlaylist.update({ where: { id }, data: { updatedAt: new Date() } });
}

export async function removeFromPlaylist(profileId: string, id: string, itemId: string) {
  await owned(profileId, id);
  await db.musicPlaylistItem.deleteMany({ where: { id: itemId, playlistId: id } });
  const rest = await db.musicPlaylistItem.findMany({ where: { playlistId: id }, orderBy: { position: "asc" }, select: { id: true } });
  await db.$transaction(rest.map((r, position) => db.musicPlaylistItem.update({ where: { id: r.id }, data: { position } })));
}

/** Queue inputs for playing a playlist: unavailable entries are skipped, matches keep their pinned source. */
export async function playlistInputs(profileId: string, id: string): Promise<{ inputs: ItemInput[]; ids: string[] }> {
  await owned(profileId, id);
  const items = await db.musicPlaylistItem.findMany({ where: { playlistId: id, NOT: { availability: "unavailable" } }, orderBy: { position: "asc" } });
  return {
    ids: items.map((i) => i.id),
    inputs: items.map((i) => (i.trackId ? { trackId: i.trackId } : { title: i.title, artist: i.artist, album: i.album, durationSec: i.durationSec, artworkUrl: i.artworkUrl, candidate: i.candidate ? JSON.parse(i.candidate) : null })),
  };
}

// ---------- Spotify import / sync ----------
async function writeImported(playlistId: string, imp: ImportedPlaylist) {
  await db.musicPlaylistItem.deleteMany({ where: { playlistId } });
  let position = 0;
  for (const t of imp.tracks) {
    const local = await findLocalMatch(t.title, t.artist, t.durationSec);
    await db.musicPlaylistItem.create({
      data: { playlistId, position: position++, trackId: local?.id ?? null, title: t.title, artist: t.artist, album: t.album ?? null, durationSec: t.durationSec ?? null, artworkUrl: t.artworkUrl ?? null, externalId: t.externalId ?? null, isrc: t.isrc ?? null, availability: local ? "local" : null },
    });
  }
  await db.musicPlaylist.update({ where: { id: playlistId }, data: { name: imp.name.slice(0, 120), description: imp.description?.slice(0, 500) ?? undefined, artworkUrl: imp.artworkUrl ?? null, lastSyncedAt: new Date() } });
}

function mapSpotifyError(e: unknown): never {
  if (e instanceof SpotifyError) throw new HttpError(e.status, e.message);
  throw e;
}

export async function importSpotify(profileId: string, user: { role: "ADMIN" | "USER" }, url: string) {
  let imp: ImportedPlaylist;
  try { imp = await fetchSpotify(url); } catch (e) { return mapSpotifyError(e); }
  const existing = await db.musicPlaylist.findFirst({ where: { profileId, source: "spotify", sourceId: imp.sourceId } });
  const id = existing?.id ?? (await db.musicPlaylist.create({ data: { profileId, name: imp.name.slice(0, 120), source: "spotify", sourceUrl: url.trim(), sourceId: imp.sourceId } })).id;
  await writeImported(id, imp);
  startCheck(profileId, user, id);
  return { id, imported: imp.tracks.length, truncated: imp.truncated, via: imp.via, updatedExisting: !!existing };
}

export async function syncPlaylist(profileId: string, user: { role: "ADMIN" | "USER" }, id: string) {
  const p = await owned(profileId, id);
  if (p.source !== "spotify" || !p.sourceUrl) throw new HttpError(400, "Only imported Spotify playlists can be synchronised");
  let imp: ImportedPlaylist;
  try { imp = await fetchSpotify(p.sourceUrl); } catch (e) { return mapSpotifyError(e); }
  await writeImported(id, imp);
  startCheck(profileId, user, id);
  return { imported: imp.tracks.length, truncated: imp.truncated, via: imp.via };
}

// ---------- availability check (library match, then the on-demand source) ----------
export interface CheckStatus { running: boolean; done: number; total: number }
const g = globalThis as unknown as { __riftChecks?: Map<string, CheckStatus> };
const checks = (g.__riftChecks ??= new Map());
export const checkStatus = (id: string): CheckStatus | null => checks.get(id) ?? null;

/** Runs in the background (the actual searching happens in the worker); callers poll `checkStatus`. */
export function startCheck(profileId: string, user: { role: "ADMIN" | "USER" }, playlistId: string, force = false): CheckStatus {
  const cur = checks.get(playlistId);
  if (cur?.running) return cur;
  const st: CheckStatus = { running: true, done: 0, total: 0 };
  checks.set(playlistId, st);
  void (async () => {
    try {
      const s = await getSettings();
      const mode = musicMode(s, user);
      const cfg = toWorkerConfig(s);
      const items = await db.musicPlaylistItem.findMany({ where: { playlistId, ...(force ? {} : { OR: [{ availability: null }, { availability: "unavailable", checkedAt: { lt: new Date(Date.now() - 3600_000) } }] }) }, orderBy: { position: "asc" } });
      st.total = items.length;
      let i = 0;
      const one = async () => {
        for (;;) {
          const it = items[i++];
          if (!it) return;
          let availability: Availability = "unavailable", note: string | null = null, candidate: Candidate | null = null, trackId: string | null = it.trackId;
          try {
            const local = mode.local ? await findLocalMatch(it.title, it.artist, it.durationSec ?? undefined) : null;
            if (local) { availability = "local"; trackId = local.id; }
            else if (!mode.onDemand) note = mode.onDemandReason ?? "Not in your library, and on-demand streaming is off.";
            else {
              const r = await musicWorker.resolve(cfg, { title: it.title, artist: it.artist, album: it.album ?? undefined, durationSec: it.durationSec ?? undefined });
              candidate = r.candidates[0] ?? null;
              if (candidate) availability = "ondemand"; else note = "No authorised source has this track.";
            }
          } catch (e) { note = (e as Error).message.slice(0, 300); }
          await db.musicPlaylistItem.update({ where: { id: it.id }, data: { availability, availabilityNote: note, candidate: candidate ? JSON.stringify(candidate) : null, trackId, checkedAt: new Date() } }).catch(() => {});
          st.done++;
        }
      };
      await Promise.all([one(), one()]);
    } catch (e) { console.error("[music] playlist check failed:", e); }
    finally { st.running = false; setTimeout(() => { if (checks.get(playlistId) === st) checks.delete(playlistId); }, 60_000).unref(); }
  })();
  return st;
}
