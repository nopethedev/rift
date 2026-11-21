import { route } from "@/server/api";
import { getTorrentManager } from "@/server/torrents/manager";
import { mapTorrentError, readTorrentSource } from "@/server/admin-torrents";

/** Fetches torrent metadata (file list) without downloading, so the admin can pick files. */
export const POST = route("admin", async ({ req }) => {
  const { source } = await readTorrentSource(req);
  try {
    return { preview: await getTorrentManager().previewMetadata(source) };
  } catch (e) {
    mapTorrentError(e);
  }
});
