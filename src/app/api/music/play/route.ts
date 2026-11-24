import { z } from "zod";
import { route, body, HttpError } from "@/server/api";
import { advance, loadQueue, modeFor, peekNext } from "@/server/music/queue";
import { playItem } from "@/server/music/playback";

export const dynamic = "force-dynamic";

/**
 * Start playback. Body: { itemId } to play a queue item, { dir: "next"|"prev", auto? } to move, or {} for the current one.
 * Prepares the audio (library file, or an on-demand capture in the worker) and returns how to fetch it.
 */
export const POST = route("profile", async ({ req, auth, profile }) => {
  const b = await body(req, z.object({ itemId: z.string().max(64).optional(), dir: z.enum(["next", "prev"]).optional(), auto: z.boolean().optional(), caps: z.object({ opus: z.boolean().optional(), flac: z.boolean().optional(), aac: z.boolean().optional(), mp3: z.boolean().optional(), vorbis: z.boolean().optional() }).optional(), forceTranscode: z.boolean().optional(), peek: z.boolean().optional() }));
  const ctx = { profileId: profile.id, user: auth.user };
  if (b.peek) {
    // The song after this one, prepared ahead without moving the queue: the player switches to it the instant the current
    // song ends (no network wait), which keeps a backgrounded phone playing. The player then commits it with a normal call.
    const id = b.itemId ?? (await peekNext(profile.id, await modeFor(auth.user)));
    if (!id) return { play: null, queue: await loadQueue(profile.id), ended: true };
    return { play: await playItem(ctx, id, b.caps, false, { peek: true }), queue: await loadQueue(profile.id), ended: false };
  }
  let itemId = b.itemId;
  if (!itemId && b.dir) {
    const r = await advance(profile.id, b.dir, !!b.auto, await modeFor(auth.user));
    if (!r.itemId) return { play: null, queue: r.queue, ended: true };
    itemId = r.itemId;
  }
  if (!itemId) itemId = (await loadQueue(profile.id)).state.currentItemId ?? undefined;
  if (!itemId) throw new HttpError(400, "The queue is empty");
  const play = await playItem(ctx, itemId, b.caps, b.forceTranscode);
  return { play, queue: await loadQueue(profile.id), ended: false };
});
