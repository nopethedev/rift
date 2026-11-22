import { z } from "zod";
import { route, body } from "@/server/api";
import { recordPlay } from "@/server/music/playback";

export const POST = route("profile", async ({ req, profile }) => {
  const b = await body(req, z.object({ itemId: z.string().max(64), playedSec: z.number().min(0).max(100000), completed: z.boolean(), kind: z.enum(["local", "ondemand"]) }));
  await recordPlay(profile.id, b.itemId, b.playedSec, b.completed, b.kind);
  return { ok: true };
});
