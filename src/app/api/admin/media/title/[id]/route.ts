import { rm } from "node:fs/promises";
import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";

type P = { id: string };

const fileSelect = { id: true, path: true, size: true, status: true, source: true, container: true, videoCodec: true, audioCodec: true, width: true, height: true, durationSec: true, subtitles: { select: { id: true, label: true, language: true, format: true, source: true } } } as const;

export const GET = route<P>("admin", async ({ params }) => {
  const t = await db.title.findUnique({
    where: { id: params.id },
    include: { files: { select: fileSelect }, episodes: { orderBy: [{ season: "asc" }, { number: "asc" }], include: { files: { select: fileSelect } } } },
  });
  if (!t) throw new HttpError(404, "Title not found");
  return {
    id: t.id, type: t.type, tmdbId: t.tmdbId, title: t.title, year: t.year,
    files: t.files,
    episodes: t.episodes.filter((e) => e.files.length).map((e) => ({ id: e.id, season: e.season, number: e.number, name: e.name, files: e.files })),
  };
});

/** Remove a title from the library. `?deleteFiles=1` also deletes the media files from disk. */
export const DELETE = route<P>("admin", async ({ req, params }) => {
  const t = await db.title.findUnique({ where: { id: params.id }, include: { files: true, episodes: { include: { files: true } } } });
  if (!t) throw new HttpError(404, "Title not found");
  const files = [...t.files, ...t.episodes.flatMap((e) => e.files)];
  if (req.nextUrl.searchParams.get("deleteFiles") === "1") for (const f of files) await rm(f.path, { force: true });
  await db.mediaFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  await db.title.delete({ where: { id: t.id } });
  return { ok: true, removed: files.length };
});
