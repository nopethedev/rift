import { route } from "@/server/api";
import { clearQueue } from "@/server/music/queue";
import { musicWorker } from "@/server/music/worker";

export const POST = route("profile", async ({ profile }) => {
  const q = await clearQueue(profile.id);
  await musicWorker.release({ holder: profile.id }).catch(() => {}); // nothing is needed any more
  return q;
});
