import path from "node:path";
import { route, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { getTorrentStreamer } from "@/server/torrents/streamer";
import { mapTorrentError } from "@/server/admin-torrents";
import { requireOnDemand, requireStreamAccess } from "@/server/ondemand";
import type { PlayerInfo } from "@/lib/types";

/** Player bootstrap for a torrent stream (probe result of the pre-buffered container headers). */
export const GET = route<{ id: string }>("profile", async ({ params, auth }) => {
  await requireOnDemand(auth);
  requireStreamAccess(auth, params.id);
  const st = getTorrentStreamer();
  try {
    const v = st.get(params.id);
    const probe = st.probe(params.id);
    if (v.status !== "ready" || !probe) throw new HttpError(409, "Stream is not ready yet");
    const settings = await getSettings();
    const vs = probe.streams.find((s) => s.type === "video");
    const m = v.meta;
    const info: PlayerInfo = {
      fileId: params.id,
      title: m?.title ?? path.basename(v.fileName ?? v.name).replace(/\.[^.]+$/, "").replace(/[._]+/g, " "),
      subtitle: m?.subtitle ?? "Streaming on demand · deleted after you leave",
      durationSec: probe.durationSec,
      container: probe.container,
      video: vs ? { codec: vs.codec, width: vs.width ?? 0, height: vs.height ?? 0, hdr: vs.hdr, bitDepth: vs.bitDepth } : null,
      audio: probe.streams.filter((s) => s.type === "audio").map((a) => ({ index: a.index, codec: a.codec, language: a.language, title: a.title, channels: a.channels, default: a.default })),
      subtitles: [],
      resumeSec: 0,
      next: null,
      ladder: settings.transcodeLadder,
      enforceMediabunnyAudio: settings.enforceMediabunnyAudio,
      backPath: m?.backPath ?? (auth.user.role === "ADMIN" ? "/admin/streams" : "/"),
    };
    return info;
  } catch (e) {
    mapTorrentError(e);
  }
});
