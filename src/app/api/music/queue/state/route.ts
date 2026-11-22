import { z } from "zod";
import { route, body } from "@/server/api";
import { patchState } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const PATCH = route("profile", async ({ req, auth, profile }) => {
  const b = await body(req, z.object({ shuffle: z.boolean().optional(), repeat: z.enum(["off", "all", "one"]).optional(), autoplay: z.boolean().optional(), positionSec: z.number().min(0).max(100000).optional() }));
  const q = await patchState(profile.id, b);
  if (b.shuffle !== undefined || b.repeat) void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {}); // the "next two" may have changed
  return q;
});
