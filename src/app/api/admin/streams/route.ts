import { db } from "@/server/db";
import { route } from "@/server/api";
import { listWorkerSessions, stopWorkerSession } from "@/server/transcode";

export const GET = route("admin", async () => {
  const since = new Date(Date.now() - 45_000);
  await db.streamSession.deleteMany({ where: { lastPingAt: { lt: new Date(Date.now() - 6 * 3600_000) } } });
  const [rows, worker] = await Promise.all([
    db.streamSession.findMany({
      where: { lastPingAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      include: {
        profile: { select: { name: true, avatar: true, user: { select: { username: true } } } },
        mediaFile: { select: { durationSec: true, title: { select: { title: true } }, episode: { select: { season: true, number: true, titleRef: { select: { title: true } } } } } },
      },
    }),
    listWorkerSessions(),
  ]);
  return {
    streams: rows.map((s) => ({
      id: s.id, user: s.profile.user.username, profile: s.profile.name, avatar: s.profile.avatar, mode: s.mode, detail: s.detail, ip: s.ip,
      startedAt: s.startedAt, positionSec: s.positionSec, durationSec: s.mediaFile.durationSec,
      title: s.mediaFile.episode ? `${s.mediaFile.episode.titleRef.title} · S${s.mediaFile.episode.season}E${s.mediaFile.episode.number}` : s.mediaFile.title?.title ?? "Unknown",
    })),
    transcodes: worker,
  };
});

/** Stop a transcode session on the worker (viewers will reconnect/err out). */
export const DELETE = route("admin", async ({ req }) => {
  const id = req.nextUrl.searchParams.get("session");
  if (id) await stopWorkerSession(id);
  return { ok: true };
});
