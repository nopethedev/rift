import { route } from "@/server/api";
import { getSettings } from "@/server/settings";
import { toWorkerConfig } from "@/server/music/config";
import { musicWorker } from "@/server/music/worker";

/** Delete every cached on-demand track nobody is currently using. */
export const DELETE = route("admin", async () => musicWorker.clear(toWorkerConfig(await getSettings())));
