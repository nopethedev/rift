import { z } from "zod";
import { route, body } from "@/server/api";
import { createPlaylist, listPlaylists } from "@/server/music/playlists";

export const dynamic = "force-dynamic";
export const GET = route("profile", async ({ profile }) => ({ playlists: await listPlaylists(profile.id) }));
export const POST = route("profile", async ({ req, profile }) => {
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500).optional() }));
  return { id: await createPlaylist(profile.id, b.name, b.description) };
});
