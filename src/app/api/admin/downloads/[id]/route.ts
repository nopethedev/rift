import { z } from "zod";
import { route, body, HttpError } from "@/server/api";
import { getTorrentManager } from "@/server/torrents/manager";
import { mapTorrentError } from "@/server/admin-torrents";

type P = { id: string };

export const PATCH = route<P>("admin", async ({ req, params }) => {
  const d = await body(req, z.object({ action: z.enum(["pause", "resume", "import", "files"]), selectedFiles: z.array(z.number().int().min(0)).max(10000).optional() }));
  const m = getTorrentManager();
  try {
    switch (d.action) {
      case "pause": return { download: await m.pause(params.id) };
      case "resume": return { download: await m.resume(params.id) };
      case "import": return { download: await m.importNow(params.id) };
      case "files":
        if (!d.selectedFiles?.length) throw new HttpError(400, "Select at least one file");
        return { download: await m.setSelectedFiles(params.id, d.selectedFiles) };
    }
  } catch (e) {
    mapTorrentError(e);
  }
});

export const DELETE = route<P>("admin", async ({ req, params }) => {
  try {
    await getTorrentManager().remove(params.id, { deleteFiles: req.nextUrl.searchParams.get("deleteFiles") === "1" });
    return { ok: true };
  } catch (e) {
    mapTorrentError(e);
  }
});
