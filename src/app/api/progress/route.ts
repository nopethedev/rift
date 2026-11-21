import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";

const schema = z.object({
  mediaFileId: z.string().min(1).max(40),
  position: z.number().min(0).max(1e6),
  duration: z.number().min(0).max(1e6),
  streamId: z.string().max(40).optional(),
  mode: z.enum(["direct", "mediabunny", "hls"]).optional(),
  detail: z.string().max(200).optional(),
});

/** Playback heartbeat: stores per-profile progress and refreshes the active-stream row. */
export const POST = route("profile", async ({ req, auth, profile, ip }) => {
  const d = await body(req, schema);
  const file = await db.mediaFile.findUnique({ where: { id: d.mediaFileId }, include: { episode: true } });
  if (!file) throw new HttpError(404, "Media not found");
  const titleId = file.titleId ?? file.episode?.titleId;
  if (!titleId) return { ok: true };
  const duration = d.duration || file.durationSec || 0;
  const completed = duration > 0 && (d.position / duration > 0.92 || duration - d.position < 90);
  await db.watchProgress.upsert({
    where: { profileId_mediaFileId: { profileId: profile.id, mediaFileId: file.id } },
    create: { profileId: profile.id, mediaFileId: file.id, titleId, episodeId: file.episodeId, positionSec: d.position, durationSec: duration, completed },
    update: { positionSec: completed ? 0 : d.position, durationSec: duration, completed },
  });
  if (d.streamId) {
    await db.streamSession
      .upsert({
        where: { id: d.streamId },
        create: { id: d.streamId, userId: auth.user.id, profileId: profile.id, mediaFileId: file.id, mode: d.mode ?? "direct", detail: d.detail, ip, positionSec: d.position },
        update: { lastPingAt: new Date(), positionSec: d.position, mode: d.mode, detail: d.detail },
      })
      .catch(() => {});
  }
  return { ok: true, completed };
});

/** Player closed — remove the active stream row. */
export const DELETE = route("profile", async ({ req, auth }) => {
  const id = req.nextUrl.searchParams.get("streamId");
  if (id) await db.streamSession.deleteMany({ where: { id, userId: auth.user.id } });
  return { ok: true };
});
