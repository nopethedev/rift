import { z } from "zod";
import { route, body } from "@/server/api";
import { deletePlaylist, getPlaylist, updatePlaylist } from "@/server/music/playlists";

export const dynamic = "force-dynamic";
export const GET = route<{ id: string }>("profile", async ({ params, profile }) => getPlaylist(profile.id, params.id));
export const PATCH = route<{ id: string }>("profile", async ({ req, params, profile }) => {
  await updatePlaylist(profile.id, params.id, await body(req, z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional() })));
});
export const DELETE = route<{ id: string }>("profile", async ({ params, profile }) => { await deletePlaylist(profile.id, params.id); });
