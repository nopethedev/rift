import { z } from "zod";
import { route, parse, json } from "@/server/api";
import { getTorrentManager } from "@/server/torrents/manager";
import { withArt } from "@/server/download-art";
import { mapTorrentError, readTorrentSource } from "@/server/admin-torrents";

const extra = z.object({
  selectedFiles: z.array(z.number().int().min(0)).max(10000).optional(),
  tmdbId: z.number().int().positive().optional(),
  mediaType: z.enum(["movie", "tv"]).optional(),
  season: z.number().int().min(0).max(200).optional(),
});

export const GET = route("admin", async () => ({ downloads: await withArt(await getTorrentManager().list()) }));

/** Add a download from a magnet link, an uploaded .torrent (multipart) or a torrent-search result. Admin initiated only. */
export const POST = route("admin", async ({ req, auth }) => {
  const { source, fields } = await readTorrentSource(req);
  const d = parse(extra, fields);
  try {
    const view = await getTorrentManager().add({ ...source, ...d, createdBy: auth.user.id });
    return json({ download: view }, { status: 201 });
  } catch (e) {
    mapTorrentError(e);
  }
});
