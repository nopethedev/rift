import { z } from "zod";
import { route, body } from "@/server/api";
import { itemInput } from "@/server/music/queue";
import { listSaved, saveSong, savedKeys, unsaveSong } from "@/server/music/saved";

export const dynamic = "force-dynamic";
/** `?keys=1` returns just the saved song keys (for the heart buttons); otherwise the full list. */
export const GET = route("profile", async ({ req, profile }) => {
  if (req.nextUrl.searchParams.get("keys")) return { keys: await savedKeys(profile.id) };
  return { items: await listSaved(profile.id) };
});
export const POST = route("profile", async ({ req, profile }) => ({ item: await saveSong(profile.id, await body(req, itemInput)) }), { rate: { key: "music-save", max: 120, windowMs: 60_000 } });
export const DELETE = route("profile", async ({ req, profile }) => { await unsaveSong(profile.id, (await body(req, z.object({ key: z.string().min(1).max(700) }))).key); });
