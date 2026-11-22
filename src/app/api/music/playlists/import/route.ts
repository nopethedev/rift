import { z } from "zod";
import { route, body } from "@/server/api";
import { importSpotify } from "@/server/music/playlists";

export const maxDuration = 120;
/** Paste a Spotify playlist/album link: imports names, artists, artwork and order (metadata only), matches it to the library and checks on-demand sources. */
export const POST = route("profile", async ({ req, auth, profile }) => {
  const { url } = await body(req, z.object({ url: z.string().trim().min(10).max(500) }));
  return importSpotify(profile.id, auth.user, url);
}, { rate: { key: "music-import", max: 10, windowMs: 60_000 } });
