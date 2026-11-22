import { rm } from "node:fs/promises";
import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { invalidateMatchIndex } from "@/server/music/catalog";

/** Remove a track from the library. `?file=1` also deletes the audio file (only for files Rift stored itself: uploads). */
export const DELETE = route<{ id: string }>("admin", async ({ req, params }) => {
  const t = await db.musicTrack.findUnique({ where: { id: params.id } });
  if (!t) throw new HttpError(404, "Track not found");
  await db.musicTrack.delete({ where: { id: t.id } });
  if (req.nextUrl.searchParams.get("file") === "1" && t.source === "upload") await rm(t.path, { force: true });
  invalidateMatchIndex();
});
