import { z } from "zod";
import { route, body, HttpError } from "@/server/api";
import { radioFromTrack } from "@/server/music/recommend";
import { replaceQueue } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

/** Start a radio from a track: the seed first, then similar tracks (same artist / genre / era). */
export const POST = route("profile", async ({ req, auth, profile }) => {
  const { trackId } = await body(req, z.object({ trackId: z.string().min(1).max(64) }));
  const similar = await radioFromTrack(trackId, 40);
  if (!similar.length) throw new HttpError(404, "Track not found");
  const q = await replaceQueue(profile.id, [{ trackId }, ...similar.map((t) => ({ trackId: t.id }))], { startIndex: 0, shuffle: false, origin: "radio" });
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {});
  return q;
});
