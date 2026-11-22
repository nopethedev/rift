import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { nextEpisodeFile } from "@/server/catalog";
import { aiState, maybeAutoGenerate } from "@/server/subtitle-ai";
import type { ProbeResult } from "@shared/probe";
import type { PlayerInfo } from "@/lib/types";

/** Everything the player needs to pick a playback mode and show tracks. */
export const GET = route<{ id: string }>("profile", async ({ params, profile, auth }) => {
  const file = await db.mediaFile.findUnique({
    where: { id: params.id },
    include: { title: true, episode: { include: { titleRef: true } }, subtitles: { orderBy: { createdAt: "asc" } } },
  });
  if (!file || file.status === "missing") throw new HttpError(404, "Media not found");
  const settings = await getSettings();
  let probe: ProbeResult | null = null;
  try { probe = file.probe ? (JSON.parse(file.probe) as ProbeResult) : null; } catch { /* re-probed below if needed */ }
  if (!probe) {
    const { probeFile } = await import("@shared/probe");
    probe = await probeFile(file.path).catch(() => null);
  }
  if (!probe) throw new HttpError(422, "File could not be analysed by FFprobe");

  const v = probe.streams.find((s) => s.type === "video");
  const audio = probe.streams.filter((s) => s.type === "audio");
  const progress = await db.watchProgress.findUnique({ where: { profileId_mediaFileId: { profileId: profile.id, mediaFileId: file.id } } });
  const ep = file.episode;
  const show = ep?.titleRef;
  const next = ep ? await nextEpisodeFile(ep.titleId, ep.season, ep.number) : null;

  const resumeSec = progress && !progress.completed && progress.positionSec > 10 ? progress.positionSec : 0;
  // Automatic subtitles: a title with no subtitles at all gets them generated (from where the viewer is), if switched on.
  await maybeAutoGenerate(file.id, auth.user, resumeSec, file.subtitles.length > 0);
  const subtitles = file.subtitles.length ? file.subtitles : await db.subtitle.findMany({ where: { mediaFileId: file.id }, orderBy: { createdAt: "asc" } });
  const ai = await aiState(file.id, auth.user);

  const info: PlayerInfo = {
    fileId: file.id,
    title: show?.title ?? file.title?.title ?? file.rawName ?? "Untitled",
    subtitle: ep ? `S${ep.season}:E${ep.number}${ep.name ? " · " + ep.name : ""}` : undefined,
    durationSec: probe.durationSec || file.durationSec || 0,
    container: probe.container,
    video: v ? { codec: v.codec, width: v.width ?? 0, height: v.height ?? 0, hdr: v.hdr, bitDepth: v.bitDepth } : null,
    audio: audio.map((a) => ({ index: a.index, codec: a.codec, language: a.language, title: a.title, channels: a.channels, default: a.default })),
    subtitles: subtitles.map((s) => ({ id: s.id, label: s.label, language: s.language ?? undefined, isDefault: s.isDefault, ...(s.source === "auto" ? { auto: true, status: s.status as "ready" | "generating" | "failed", progress: s.progress ?? undefined, note: s.note ?? undefined } : {}) })),
    resumeSec,
    next,
    ladder: settings.transcodeLadder,
    enforceMediabunnyAudio: settings.enforceMediabunnyAudio,
    canFindSubtitles: auth.user.role === "ADMIN" && !!settings.opensubtitlesApiKey,
    ai: { available: ai.available, reason: ai.reason, mayStart: ai.available && (!ai.subtitle || ai.subtitle.status === "failed") },
    backPath: show ? `/title/tv/${show.tmdbId}` : file.title?.tmdbId ? `/title/movie/${file.title.tmdbId}` : "/",
  };
  return info;
});
