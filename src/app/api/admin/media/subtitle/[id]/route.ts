import { rm } from "node:fs/promises";
import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";

export const DELETE = route<{ id: string }>("admin", async ({ params }) => {
  const s = await db.subtitle.findUnique({ where: { id: params.id } });
  if (!s) throw new HttpError(404, "Subtitle not found");
  await rm(s.path, { force: true });
  await db.subtitle.delete({ where: { id: s.id } });
  return { ok: true };
});
