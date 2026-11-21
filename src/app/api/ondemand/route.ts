import { z } from "zod";
import { route, parse, json } from "@/server/api";
import { getTorrentStreamer } from "@/server/torrents/streamer";
import { mapTorrentError, readTorrentSource } from "@/server/admin-torrents";

export const GET = route("admin", async () => ({ streams: getTorrentStreamer().list() }));

/**
 * Start an on-demand stream from a magnet link, an uploaded .torrent or a torrent-search result.
 * Admin initiated only. Files live in a temporary cache and are deleted after ~1 minute without a heartbeat.
 */
export const POST = route("admin", async ({ req, auth }) => {
  const { source, fields } = await readTorrentSource(req);
  const d = parse(z.object({ fileIndex: z.number().int().min(0).optional() }), fields);
  try {
    return json({ stream: await getTorrentStreamer().start({ ...source, fileIndex: d.fileIndex, ownerId: auth.user.id }) }, { status: 201 });
  } catch (e) {
    mapTorrentError(e);
  }
});
