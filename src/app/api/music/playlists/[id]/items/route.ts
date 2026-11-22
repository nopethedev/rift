import { z } from "zod";
import { route, body } from "@/server/api";
import { itemInput } from "@/server/music/queue";
import { addToPlaylist, removeFromPlaylist } from "@/server/music/playlists";

export const POST = route<{ id: string }>("profile", async ({ req, params, profile }) => {
  const b = await body(req, z.object({ items: z.array(itemInput).min(1).max(500) }));
  await addToPlaylist(profile.id, params.id, b.items);
});
export const DELETE = route<{ id: string }>("profile", async ({ req, params, profile }) => {
  const b = await body(req, z.object({ itemId: z.string().min(1).max(64) }));
  await removeFromPlaylist(profile.id, params.id, b.itemId);
});
