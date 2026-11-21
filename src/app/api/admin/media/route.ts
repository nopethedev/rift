import { db } from "@/server/db";
import { route } from "@/server/api";

/** Library listing for the admin Media page. */
export const GET = route("admin", async ({ req }) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  const [titles, unmatched, missing] = await Promise.all([
    db.title.findMany({
      where: { ...(q ? { title: { contains: q } } : {}), OR: [{ files: { some: {} } }, { episodes: { some: { files: { some: {} } } } }] },
      orderBy: { title: "asc" },
      take: 500,
      include: { files: { select: { id: true, size: true, status: true } }, episodes: { select: { files: { select: { id: true, size: true, status: true } } } } },
    }),
    db.mediaFile.findMany({ where: { status: "unmatched" }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.mediaFile.count({ where: { status: "missing" } }),
  ]);
  return {
    titles: titles.map((t) => {
      const files = [...t.files, ...t.episodes.flatMap((e) => e.files)];
      return {
        id: t.id, type: t.type, tmdbId: t.tmdbId, title: t.title, year: t.year, posterPath: t.posterPath,
        fileCount: files.length, episodeCount: t.type === "show" ? t.episodes.filter((e) => e.files.length).length : 0,
        sizeBytes: files.reduce((a, f) => a + Number(f.size), 0), missing: files.filter((f) => f.status === "missing").length,
      };
    }),
    unmatched: unmatched.map((f) => ({ id: f.id, path: f.path, rawName: f.rawName, size: Number(f.size), durationSec: f.durationSec, source: f.source, createdAt: f.createdAt })),
    missing,
  };
});
