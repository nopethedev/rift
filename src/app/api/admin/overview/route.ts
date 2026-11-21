import { db } from "@/server/db";
import { route } from "@/server/api";
import { workerHealth, listWorkerSessions } from "@/server/transcode";
import { tmdbConfigured } from "@/server/tmdb";

export const GET = route("admin", async () => {
  const since = new Date(Date.now() - 45_000);
  const [users, movies, shows, episodes, files, unmatched, activeStreams, downloads, sizeAgg, recent, worker, workerSessions, tmdb] = await Promise.all([
    db.user.count(),
    db.title.count({ where: { type: "movie", files: { some: {} } } }),
    db.title.count({ where: { type: "show", episodes: { some: { files: { some: {} } } } } }),
    db.episode.count({ where: { files: { some: {} } } }),
    db.mediaFile.count({ where: { status: "ready" } }),
    db.mediaFile.count({ where: { status: "unmatched" } }),
    db.streamSession.count({ where: { lastPingAt: { gte: since } } }),
    db.download.groupBy({ by: ["status"], _count: true }),
    db.mediaFile.aggregate({ _sum: { size: true } }),
    db.mediaFile.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { title: { select: { title: true } }, episode: { include: { titleRef: { select: { title: true } } } } } }),
    workerHealth(),
    listWorkerSessions(),
    tmdbConfigured(),
  ]);
  return {
    users, movies, shows, episodes, files, unmatched, activeStreams,
    downloads: Object.fromEntries(downloads.map((d) => [d.status, d._count])),
    libraryBytes: Number(sizeAgg._sum.size ?? 0),
    recent: recent.map((f) => ({
      id: f.id, status: f.status, createdAt: f.createdAt, source: f.source,
      name: f.episode ? `${f.episode.titleRef.title} S${f.episode.season}E${f.episode.number}` : f.title?.title ?? f.rawName ?? f.path.split("/").pop(),
    })),
    worker, transcodeSessions: workerSessions.length, tmdb,
  };
});
