import "server-only";
import { z } from "zod";
import { db } from "../db";
import { HttpError } from "../api";
import { getSettings } from "../settings";
import type { MusicQueueItem, MusicQueueState } from "@/generated/prisma/client";
import type { Candidate } from "@shared/music-protocol";
import { makeShuffleOrder, moveItem, nextId, playOrder, prevId, restoreOrder, type RepeatMode } from "@/lib/music-queue";
import { coverUrl } from "./catalog";
import { musicMode, type MusicMode } from "./config";
import { recommendLocal } from "./recommend";
import { unseal } from "./seal";

export interface QueueItemDTO {
  id: string; trackId: string | null; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null;
  origin: string; local: boolean; candidate: Candidate | null;
}
export interface QueueStateDTO { currentItemId: string | null; shuffle: boolean; repeat: RepeatMode; autoplay: boolean; positionSec: number }
export interface QueueDTO { items: QueueItemDTO[]; state: QueueStateDTO }

export const itemInput = z.union([
  z.object({ trackId: z.string().min(1).max(64) }),
  z.object({
    title: z.string().min(1).max(300), artist: z.string().max(300).default(""), album: z.string().max(300).nullish(), durationSec: z.number().min(0).max(36000).nullish(),
    artworkUrl: z.string().max(1000).nullish(), candidate: z.any().nullish(),
  }),
]);
export type ItemInput = z.infer<typeof itemInput>;

const toItem = (r: MusicQueueItem): QueueItemDTO => ({
  id: r.id, trackId: r.trackId, title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec, artworkUrl: r.artworkUrl, origin: r.origin, local: !!r.trackId,
  candidate: r.candidate ? (JSON.parse(r.candidate) as Candidate) : null,
});
const toState = (s: MusicQueueState): QueueStateDTO => ({ currentItemId: s.currentItemId, shuffle: s.shuffle, repeat: s.repeat as RepeatMode, autoplay: s.autoplay, positionSec: s.positionSec });

export async function ensureState(profileId: string): Promise<MusicQueueState> {
  return db.musicQueueState.upsert({ where: { profileId }, create: { profileId }, update: {} });
}

async function rows(profileId: string) {
  return db.musicQueueItem.findMany({ where: { profileId }, orderBy: { position: "asc" } });
}

/** Writes `ids` as the new queue order (position = index). */
async function applyOrder(ids: string[]) {
  if (ids.length) await db.$transaction(ids.map((id, position) => db.musicQueueItem.update({ where: { id }, data: { position } })));
}

export async function loadQueue(profileId: string): Promise<QueueDTO> {
  const [items, state] = await Promise.all([rows(profileId), ensureState(profileId)]);
  return { items: items.map(toItem), state: toState(state) };
}

/** Normalises inputs into row data (local tracks are looked up; everything else is kept as an external reference). */
async function dataFor(inputs: ItemInput[], origin: string) {
  const ids = inputs.flatMap((i) => ("trackId" in i ? [i.trackId] : []));
  const tracks = ids.length ? await db.musicTrack.findMany({ where: { id: { in: ids }, status: "ready" } }) : [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out: Omit<MusicQueueItem, "id" | "profileId" | "position">[] = [];
  for (const i of inputs) {
    if ("trackId" in i) {
      const t = byId.get(i.trackId);
      if (!t) continue;
      out.push({ trackId: t.id, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, artworkUrl: coverUrl(t.coverHash), candidate: null, origin });
    } else {
      out.push({ trackId: null, title: i.title, artist: i.artist, album: i.album ?? null, durationSec: i.durationSec ?? null, artworkUrl: i.artworkUrl ?? null, candidate: unseal(i.candidate) ? JSON.stringify(unseal(i.candidate)) : null, origin }); // forged candidates are dropped
    }
  }
  return out;
}

export async function replaceQueue(profileId: string, inputs: ItemInput[], o: { startIndex?: number; shuffle?: boolean; origin?: string } = {}): Promise<QueueDTO> {
  const data = await dataFor(inputs, o.origin ?? "manual");
  if (!data.length) throw new HttpError(400, "Nothing playable to queue");
  await db.musicQueueItem.deleteMany({ where: { profileId } });
  await db.musicQueueItem.createMany({ data: data.map((d, position) => ({ ...d, profileId, position })) });
  const created = await rows(profileId);
  const start = created[Math.min(Math.max(o.startIndex ?? 0, 0), created.length - 1)];
  const cur = o.shuffle && o.startIndex === undefined ? created[Math.floor(Math.random() * created.length)] : start;
  const shuffle = o.shuffle ?? (await ensureState(profileId)).shuffle;
  const original = created.map((c) => c.id);
  // Shuffling reorders the queue itself (the current song first), so what you see is what plays and what gets preloaded.
  if (shuffle) await applyOrder(makeShuffleOrder(original, cur.id));
  await db.musicQueueState.update({ where: { profileId }, data: { currentItemId: cur.id, positionSec: 0, shuffle, originalOrder: shuffle ? JSON.stringify(original) : null } });
  return loadQueue(profileId);
}

export async function addItems(profileId: string, inputs: ItemInput[], where: "end" | "next", origin = "manual"): Promise<QueueDTO> {
  const data = await dataFor(inputs, origin);
  if (!data.length) throw new HttpError(400, "Nothing playable to add");
  const existing = await rows(profileId);
  const state = await ensureState(profileId);
  const created = await Promise.all(data.map((d, k) => db.musicQueueItem.create({ data: { ...d, profileId, position: (existing.at(-1)?.position ?? -1) + 1 + k } })));
  const newIds = created.map((c) => c.id);
  if (where === "next" && state.currentItemId) {
    // Insert right after the current item (the queue order is the play order, shuffled or not).
    const ids = existing.map((e) => e.id);
    const at = ids.indexOf(state.currentItemId) + 1;
    const order = [...ids.slice(0, at), ...newIds, ...ids.slice(at)];
    await db.$transaction(order.map((id, position) => db.musicQueueItem.update({ where: { id }, data: { position } })));
  }
  if (!state.currentItemId) await db.musicQueueState.update({ where: { profileId }, data: { currentItemId: newIds[0] } });
  return loadQueue(profileId);
}

export async function removeItem(profileId: string, id: string): Promise<QueueDTO> {
  const q = await loadQueue(profileId);
  if (!q.items.some((i) => i.id === id)) throw new HttpError(404, "Queue item not found");
  let current = q.state.currentItemId;
  if (current === id) current = nextId(q.items.map((i, position) => ({ id: i.id, position })), q.state) ?? null;
  if (current === id) current = null;
  await db.musicQueueItem.delete({ where: { id } });
  await db.musicQueueState.update({ where: { profileId }, data: { currentItemId: current } });
  return loadQueue(profileId);
}

export async function moveQueueItem(profileId: string, id: string, toIndex: number): Promise<QueueDTO> {
  const items = await rows(profileId);
  const order = moveItem(items.map((i) => i.id), id, toIndex);
  await db.$transaction(order.map((iid, position) => db.musicQueueItem.update({ where: { id: iid }, data: { position } })));
  return loadQueue(profileId);
}

export async function clearQueue(profileId: string): Promise<QueueDTO> {
  await db.musicQueueItem.deleteMany({ where: { profileId } });
  await db.musicQueueState.update({ where: { profileId }, data: { currentItemId: null, positionSec: 0, originalOrder: null } });
  return loadQueue(profileId);
}

export async function patchState(profileId: string, p: Partial<{ shuffle: boolean; repeat: RepeatMode; autoplay: boolean; positionSec: number; currentItemId: string | null }>): Promise<QueueDTO> {
  const cur = await ensureState(profileId);
  const data: Partial<MusicQueueState> = {};
  if (p.repeat) data.repeat = p.repeat;
  if (p.autoplay !== undefined) data.autoplay = p.autoplay;
  if (p.positionSec !== undefined) data.positionSec = Math.max(0, p.positionSec);
  if (p.currentItemId !== undefined) data.currentItemId = p.currentItemId;
  if (p.shuffle !== undefined && p.shuffle !== cur.shuffle) {
    data.shuffle = p.shuffle;
    const ids = (await rows(profileId)).map((r) => r.id);
    if (p.shuffle) { // reorder the queue now: the current song stays first, the rest is shuffled; remember the old order
      await applyOrder(makeShuffleOrder(ids, cur.currentItemId));
      data.originalOrder = JSON.stringify(ids);
    } else { // switch off: back to the order it had before shuffling
      await applyOrder(restoreOrder(cur.originalOrder ? (JSON.parse(cur.originalOrder) as string[]) : [], ids));
      data.originalOrder = null;
    }
  }
  if (Object.keys(data).length) await db.musicQueueState.update({ where: { profileId }, data });
  return loadQueue(profileId);
}

/** Picks the next/previous item and makes it current. At the end of the queue, autoplay (if on) appends recommendations. */
export async function advance(profileId: string, dir: "next" | "prev", auto: boolean, mode: MusicMode): Promise<{ itemId: string | null; queue: QueueDTO; ended: boolean }> {
  let q = await loadQueue(profileId);
  const pos = () => q.items.map((i, position) => ({ id: i.id, position }));
  let id = dir === "next" ? nextId(pos(), q.state, { auto }) : prevId(pos(), q.state);
  if (!id && dir === "next" && q.state.autoplay) {
    const added = await extendWithAutoplay(profileId, mode);
    if (added) { q = await loadQueue(profileId); id = nextId(pos(), q.state); }
  }
  if (id) await db.musicQueueState.update({ where: { profileId }, data: { currentItemId: id, positionSec: 0 } });
  return { itemId: id, queue: await loadQueue(profileId), ended: !id };
}

/** What `advance(next, auto)` would pick, without moving the queue (extends it with autoplay picks at the end, like advance). */
export async function peekNext(profileId: string, mode: MusicMode): Promise<string | null> {
  let q = await loadQueue(profileId);
  const pos = () => q.items.map((i, position) => ({ id: i.id, position }));
  let id = nextId(pos(), q.state, { auto: true });
  if (!id && q.state.autoplay) {
    const added = await extendWithAutoplay(profileId, mode);
    if (added) { q = await loadQueue(profileId); id = nextId(pos(), q.state); }
  }
  return id;
}

/** Appends tracks the profile is likely to enjoy: local recommendations first, then not-recently-played on-demand favourites. */
export async function extendWithAutoplay(profileId: string, mode: MusicMode, n = 8): Promise<number> {
  const existing = await rows(profileId);
  const inQueue = new Set(existing.flatMap((e) => (e.trackId ? [e.trackId] : [])));
  let picks: ItemInput[] = mode.local ? (await recommendLocal(profileId, n, inQueue)).map((t) => ({ trackId: t.id })) : [];
  if (picks.length < n && mode.onDemand) {
    const recent = await db.musicPlay.findMany({ where: { profileId, source: "ondemand", completed: true }, orderBy: { playedAt: "desc" }, take: 200 });
    const queued = new Set(existing.map((e) => `${e.title}|${e.artist}`.toLowerCase()));
    const seen = new Set<string>();
    const later = recent.slice(10); // skip the very latest: do not replay what just played
    for (const p of later) {
      const k = `${p.title}|${p.artist}`.toLowerCase();
      if (queued.has(k) || seen.has(k)) continue;
      seen.add(k);
      picks.push({ title: p.title, artist: p.artist, album: p.album, durationSec: p.durationSec });
      if (picks.length >= n) break;
    }
  }
  if (!picks.length) return 0;
  await addItems(profileId, picks, "end", "autoplay");
  return picks.length;
}

export const modeFor = async (user: { role: "ADMIN" | "USER" }) => musicMode(await getSettings(), user);
export { playOrder };
