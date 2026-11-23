import "server-only";
import { db } from "../db";
import { HttpError } from "../api";
import { getSettings } from "../settings";
import type { EntryStatus } from "@shared/music-protocol";
import { upcoming } from "@/lib/music-queue";
import { coverUrl, findLocalMatch } from "./catalog";
import { musicMode, toWorkerConfig } from "./config";
import { loadQueue, type QueueItemDTO } from "./queue";
import { musicWorker } from "./worker";
import { findAlbumArt, onlineEnabled } from "./online";

export interface Caps { opus?: boolean; flac?: boolean; aac?: boolean; mp3?: boolean; vorbis?: boolean }

export interface PlayInfo {
  item: QueueItemDTO;
  kind: "local" | "ondemand";
  /** Audio URL. For `transcode` streams append `&start=<sec>` to seek. */
  url: string;
  /** Local file the browser can't decode: converted on the fly, seekable only by restarting at an offset. */
  transcode: boolean;
  durationSec: number | null;
  key?: string;
  status?: EntryStatus;
}

const DIRECT = new Set(["mp3", "aac", "vorbis", "flac", "opus", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8", "pcm_s16be", "pcm_s24be"]);
export function needsTranscode(codec: string | null, caps: Caps = {}, force = false): boolean {
  const c = (codec ?? "").toLowerCase();
  if (force || !DIRECT.has(c)) return true;
  const supported = (caps as Record<string, boolean | undefined>)[c];
  return supported === false; // the browser told us it can't decode this codec
}

type Ctx = { profileId: string; user: { role: "ADMIN" | "USER" } };

export async function playItem(ctx: Ctx, itemId: string, caps: Caps = {}, forceTranscode = false): Promise<PlayInfo> {
  const row = await db.musicQueueItem.findFirst({ where: { id: itemId, profileId: ctx.profileId } });
  if (!row) throw new HttpError(404, "Queue item not found");
  const s = await getSettings();
  const mode = musicMode(s, ctx.user);
  let trackId = row.trackId;
  let artwork = row.artworkUrl;

  // Hybrid / local: prefer the library, also for items that were added by name (playlists, history).
  if (!trackId && mode.local) {
    const m = await findLocalMatch(row.title, row.artist, row.durationSec ?? undefined);
    if (m) { trackId = m.id; artwork = artwork ?? coverUrl(m.coverHash); await db.musicQueueItem.update({ where: { id: row.id }, data: { trackId, artworkUrl: artwork } }); }
  }
  // No cover yet (typical for songs added by name): look one up so the player bar and the phone's lock-screen card have a picture.
  if (!artwork && !trackId) artwork = await quickArt(row.id, { artist: row.artist, album: row.album, title: row.title });
  const dto = (await loadQueue(ctx.profileId)).items.find((i) => i.id === itemId)!;

  if (trackId) {
    const t = await db.musicTrack.findUnique({ where: { id: trackId } });
    if (t && t.status === "ready") {
      const transcode = needsTranscode(t.codec, caps, forceTranscode);
      await db.musicQueueState.update({ where: { profileId: ctx.profileId }, data: { currentItemId: itemId } });
      return { item: dto, kind: "local", url: `/api/music/tracks/${t.id}/audio${transcode ? "?transcode=1" : ""}`, transcode, durationSec: t.durationSec };
    }
    if (!mode.onDemand) throw new HttpError(409, "This file is missing from the library.");
  }
  if (!mode.onDemand) throw new HttpError(409, mode.onDemandReason ?? "This track isn't in your library, and on-demand streaming is off.");

  const cfg = toWorkerConfig(s);
  const status = await musicWorker.prepare({
    cfg, holder: ctx.profileId, role: "current",
    ...(dto.candidate ? { candidate: dto.candidate } : { query: { title: row.title, artist: row.artist, album: row.album ?? undefined, durationSec: row.durationSec ?? undefined } }),
  });
  await db.musicQueueState.update({ where: { profileId: ctx.profileId }, data: { currentItemId: itemId } });
  void syncPreloads(ctx).catch(() => {});
  return { item: dto, kind: "ondemand", url: `/api/music/od/${status.key}/audio`, transcode: false, durationSec: status.durationSec ?? row.durationSec, key: status.key, status };
}

/** Cover lookup that never holds playback back for long: waits up to 1.5 s, and keeps going in the background to store the result. */
async function quickArt(itemId: string, q: { artist: string; album: string | null; title: string }): Promise<string | null> {
  if (!(await onlineEnabled().catch(() => false))) return null;
  const lookup = findAlbumArt(q).then(async (url) => { if (url) await db.musicQueueItem.update({ where: { id: itemId }, data: { artworkUrl: url } }).catch(() => {}); return url; }).catch(() => null);
  return Promise.race([lookup, new Promise<null>((r) => setTimeout(() => r(null), 1500).unref())]);
}

/** Keeps exactly the next N on-demand tracks warm in the worker cache and cancels preloads that fell out of range. */
export async function syncPreloads(ctx: Ctx): Promise<string[]> {
  const s = await getSettings();
  const mode = musicMode(s, ctx.user);
  if (!mode.onDemand || !s.musicPreload || s.musicPreloadCount < 1) {
    if (mode.onDemand) await musicWorker.release({ holder: ctx.profileId, role: "preload" }).catch(() => {});
    return [];
  }
  const q = await loadQueue(ctx.profileId);
  const ids = upcoming(q.items.map((i, position) => ({ id: i.id, position })), q.state, s.musicPreloadCount);
  const cfg = toWorkerConfig(s);
  const keys: string[] = [];
  for (const id of ids) {
    const it = q.items.find((i) => i.id === id)!;
    if (it.trackId) continue; // local files need no preloading
    if (mode.local && (await findLocalMatch(it.title, it.artist, it.durationSec ?? undefined))) continue;
    try {
      const st2 = await musicWorker.prepare({ cfg, holder: ctx.profileId, role: "preload", ...(it.candidate ? { candidate: it.candidate } : { query: { title: it.title, artist: it.artist, album: it.album ?? undefined, durationSec: it.durationSec ?? undefined } }) });
      keys.push(st2.key);
    } catch { /* limit reached or worker busy: skip this one */ }
  }
  await musicWorker.release({ holder: ctx.profileId, role: "preload", keep: keys }).catch(() => {});
  return keys;
}

export async function recordPlay(profileId: string, itemId: string, playedSec: number, completed: boolean, kind: "local" | "ondemand") {
  const row = await db.musicQueueItem.findFirst({ where: { id: itemId, profileId } });
  if (!row || playedSec < 5) return; // ignore accidental starts
  const track = row.trackId ? await db.musicTrack.findUnique({ where: { id: row.trackId }, select: { genre: true } }) : null;
  await db.musicPlay.create({ data: { profileId, trackId: row.trackId, title: row.title, artist: row.artist, album: row.album, genre: track?.genre ?? null, durationSec: row.durationSec, playedSec, completed, source: kind } });
}
