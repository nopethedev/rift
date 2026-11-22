import { z } from "zod";
import { route, body } from "@/server/api";
import { addItems, itemInput } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const POST = route("profile", async ({ req, auth, profile }) => {
  const b = await body(req, z.object({ items: z.array(itemInput).min(1).max(500), where: z.enum(["end", "next"]).default("end") }));
  const q = await addItems(profile.id, b.items, b.where);
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {});
  return q;
});
