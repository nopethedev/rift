import { z } from "zod";
import { route, parse, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { musicMode, toWorkerConfig } from "@/server/music/config";
import { musicWorker } from "@/server/music/worker";

export const dynamic = "force-dynamic";
/** Search the configured on-demand sources (yt-dlp / Lavalink). Slow, so the UI calls it separately from the library search. */
export const GET = route("profile", async ({ req, auth }) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(200) }), Object.fromEntries(req.nextUrl.searchParams));
  const s = await getSettings();
  const mode = musicMode(s, auth.user);
  if (!mode.onDemand) throw new HttpError(409, mode.onDemandReason ?? "On-demand streaming is off.");
  const { candidates } = await musicWorker.search(toWorkerConfig(s), q, 10);
  return { candidates };
}, { rate: { key: "music-od-search", max: 20, windowMs: 60_000 } });
