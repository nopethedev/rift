import { z } from "zod";
import { route, body } from "@/server/api";
import { getTorrentStreamer } from "@/server/torrents/streamer";
import { mapTorrentError } from "@/server/admin-torrents";
import { requireOnDemand, requireStreamAccess } from "@/server/ondemand";

type P = { id: string };

/** Status; also counts as a heartbeat. */
export const GET = route<P>("profile", async ({ params, auth }) => {
  await requireOnDemand(auth);
  requireStreamAccess(auth, params.id);
  try {
    return { stream: getTorrentStreamer().get(params.id) };
  } catch (e) {
    mapTorrentError(e);
  }
});

export const POST = route<P>("profile", async ({ req, params, auth }) => {
  await requireOnDemand(auth);
  requireStreamAccess(auth, params.id);
  const d = await body(req, z.object({ action: z.enum(["heartbeat", "select"]), fileIndex: z.number().int().min(0).optional() }));
  const st = getTorrentStreamer();
  try {
    if (d.action === "select" && d.fileIndex !== undefined) return { stream: await st.selectFile(params.id, d.fileIndex) };
    return { stream: st.heartbeat(params.id) };
  } catch (e) {
    mapTorrentError(e);
  }
});

/** Stop now and delete the downloaded data. */
export const DELETE = route<P>("profile", async ({ params, auth }) => {
  requireStreamAccess(auth, params.id);
  await getTorrentStreamer().destroy(params.id);
  return { ok: true };
});
