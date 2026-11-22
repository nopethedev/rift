import { z } from "zod";
import { route, body } from "@/server/api";
import { itemInput, loadQueue, replaceQueue } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const dynamic = "force-dynamic";
export const GET = route("profile", async ({ profile }) => loadQueue(profile.id));

/** Replace the queue (play an album / playlist / search result). */
export const PUT = route("profile", async ({ req, auth, profile }) => {
  const b = await body(req, z.object({ items: z.array(itemInput).min(1).max(1000), startIndex: z.number().int().min(0).optional(), shuffle: z.boolean().optional(), origin: z.string().max(20).optional() }));
  const q = await replaceQueue(profile.id, b.items, b);
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {});
  return q;
});
