import { z } from "zod";
import { route, body, HttpError } from "@/server/api";
import { previewSpotify, SpotifyError } from "@/server/music/spotify";

export const maxDuration = 60;
/** Pasted text (one or more links, or what the Spotify app shares) -> the playlists/albums it would import. */
export const POST = route("profile", async ({ req }) => {
  const { text } = await body(req, z.object({ text: z.string().trim().min(5).max(20_000) }));
  try { return { items: await previewSpotify(text) }; }
  catch (e) { if (e instanceof SpotifyError) throw new HttpError(e.status, e.message); throw e; }
}, { rate: { key: "music-import-preview", max: 20, windowMs: 60_000 } });
