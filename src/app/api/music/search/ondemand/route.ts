import { z } from "zod";
import { route, parse, HttpError } from "@/server/api";
import { getSettings } from "@/server/settings";
import { musicMode, toWorkerConfig } from "@/server/music/config";
import { musicWorker } from "@/server/music/worker";
import { seal } from "@/server/music/seal";

export const dynamic = "force-dynamic";
/** Search the configured on-demand sources (yt-dlp and Lavalink, both when both are set up) and merge the answers. Slow, so the UI calls it separately from the library search. */
export const GET = route("profile", async ({ req, auth }) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(200) }), Object.fromEntries(req.nextUrl.searchParams));
  const s = await getSettings();
  const mode = musicMode(s, auth.user);
  if (!mode.onDemand) throw new HttpError(409, mode.onDemandReason ?? "On-demand streaming is off.");
  // Direct links make the server fetch a URL of the caller's choosing: administrators only.
  if (/^\s*[a-z][a-z0-9+.-]*:\/\//i.test(q) && auth.user.role !== "ADMIN") throw new HttpError(403, "Pasting direct links is limited to administrators. Search by song or artist instead.");
  const { candidates, engines } = await musicWorker.search(toWorkerConfig(s), q, 10);
  return { candidates: candidates.map(seal), sources: engines };
}, { rate: { key: "music-od-search", max: 20, windowMs: 60_000 } });
