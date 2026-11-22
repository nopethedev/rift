import { route } from "@/server/api";
import { getSettings } from "@/server/settings";
import { libraryStats } from "@/server/music/catalog";
import { toWorkerConfig } from "@/server/music/config";
import { getMusicScanStatus } from "@/server/music/library";
import { musicWorker } from "@/server/music/worker";

export const dynamic = "force-dynamic";
export const GET = route("admin", async () => {
  const s = await getSettings();
  const worker = await musicWorker.stats(toWorkerConfig(s)).then((v) => ({ ok: true as const, ...v })).catch((e: Error) => ({ ok: false as const, error: e.message }));
  return { library: await libraryStats(), scan: getMusicScanStatus(), worker };
});
