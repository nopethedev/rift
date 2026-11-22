import { z } from "zod";
import { route, body } from "@/server/api";
import { moveQueueItem } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const POST = route("profile", async ({ req, auth, profile }) => {
  const b = await body(req, z.object({ id: z.string().min(1).max(64), toIndex: z.number().int().min(0).max(5000) }));
  const q = await moveQueueItem(profile.id, b.id, b.toIndex);
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {});
  return q;
});
