import { z } from "zod";
import { route, body } from "@/server/api";
import { requireOnDemand } from "@/server/ondemand";
import { mapTorrentError } from "@/server/admin-torrents";
import { startStreamForTitle } from "@/server/torrents/auto";

/**
 * "Play" on a title that is not in the library: the server finds the best torrent and starts an on-demand stream.
 * Allowed for admins, or for everyone when Settings → On-demand streaming says so. Capacity is enforced by the streamer.
 */
export const POST = route("profile", async ({ req, auth }) => {
  await requireOnDemand(auth);
  const d = await body(req, z.object({
    type: z.enum(["movie", "tv"]), tmdbId: z.number().int().positive(),
    season: z.number().int().min(0).max(200).optional(), episode: z.number().int().min(1).max(5000).optional(),
    exclude: z.array(z.string().regex(/^[a-fA-F0-9]{40}$/)).max(10).optional(),
  }));
  try {
    return { stream: await startStreamForTitle({ ...d, ownerId: auth.user.id }) };
  } catch (e) {
    mapTorrentError(e);
  }
}, { rate: { key: "ondemand-auto", max: 12, windowMs: 60_000 } });
