import { route } from "@/server/api";
import { musicWorker } from "@/server/music/worker";

/** Heartbeat from an active player: keeps this profile's current + preloaded on-demand audio alive. */
export const POST = route("profile", async ({ profile }) => {
  const r = await musicWorker.ping(profile.id).catch(() => ({ held: 0 }));
  return { held: r.held };
});
