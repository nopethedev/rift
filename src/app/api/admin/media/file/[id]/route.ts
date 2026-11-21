import { rm } from "node:fs/promises";
import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { linkMediaFile, ImportError } from "@/server/library/importer";

type P = { id: string };

/** Manual (re)match of a file to a TMDB movie / episode. */
export const PATCH = route<P>("admin", async ({ req, params }) => {
  const d = await body(req, z.object({ tmdbId: z.number().int().positive(), mediaType: z.enum(["movie", "tv"]), season: z.number().int().min(0).optional(), episode: z.number().int().min(1).optional() }));
  try {
    const r = await linkMediaFile(params.id, d);
    return { ok: true, status: r.status, match: r.match };
  } catch (e) {
    if (e instanceof ImportError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

export const DELETE = route<P>("admin", async ({ req, params }) => {
  const f = await db.mediaFile.findUnique({ where: { id: params.id } });
  if (!f) throw new HttpError(404, "File not found");
  if (req.nextUrl.searchParams.get("deleteFile") === "1") await rm(f.path, { force: true });
  await db.mediaFile.delete({ where: { id: f.id } });
  return { ok: true };
});
