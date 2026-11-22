import { z } from "zod";
import { route, body } from "@/server/api";
import { matchSaved } from "@/server/music/saved";

/** Manual match: { trackId } (library), { candidate } (a search result from /api/music/search/ondemand) or { clear: true }. */
export const PATCH = route<{ id: string }>("profile", async ({ req, params, profile }) => {
  const b = await body(req, z.union([z.object({ trackId: z.string().min(1).max(64) }), z.object({ candidate: z.any() }), z.object({ clear: z.literal(true) })]));
  await matchSaved(profile.id, params.id, b);
});
