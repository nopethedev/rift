import { z } from "zod";
import { route, body, HttpError } from "@/server/api";
import { playlistInputs } from "@/server/music/playlists";
import { replaceQueue } from "@/server/music/queue";
import { syncPreloads } from "@/server/music/playback";

export const POST = route<{ id: string }>("profile", async ({ req, params, auth, profile }) => {
  const b = await body(req, z.object({ shuffle: z.boolean().optional(), startItemId: z.string().max(64).optional() }));
  const { inputs, ids } = await playlistInputs(profile.id, params.id);
  if (!inputs.length) throw new HttpError(409, "None of the tracks in this playlist can be played right now.");
  const start = b.startItemId ? Math.max(0, ids.indexOf(b.startItemId)) : undefined;
  const q = await replaceQueue(profile.id, inputs, { startIndex: start, shuffle: b.shuffle, origin: "playlist" });
  void syncPreloads({ profileId: profile.id, user: auth.user }).catch(() => {});
  return q;
});
