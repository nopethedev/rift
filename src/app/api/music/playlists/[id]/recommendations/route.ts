import { z } from "zod";
import { route, body } from "@/server/api";
import { playlistRecommendations } from "@/server/music/playlists";
import { modeFor } from "@/server/music/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** "Recommended for this playlist": songs like the ones in it, ranked by the profile's taste. `shown` = keys to skip (refresh). */
export const POST = route<{ id: string }>("profile", async ({ req, params, profile, auth }) => {
  const b = await body(req, z.object({ shown: z.array(z.string().max(80)).max(200).default([]), n: z.number().int().min(1).max(30).default(10) }));
  return { items: await playlistRecommendations(profile.id, params.id, await modeFor(auth.user), b.shown, b.n) };
}, { rate: { key: "music-playlist-recs", max: 30, windowMs: 60_000 } });
