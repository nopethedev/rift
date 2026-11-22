import { z } from "zod";
import { route, body } from "@/server/api";
import { removeItem } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const POST = route("profile", async ({ req, auth, profile }) => {
  const { id } = await body(req, z.object({ id: z.string().min(1).max(64) }));
  const q = await removeItem(profile.id, id);
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {}); // cancels preloads of removed items
  return q;
});
