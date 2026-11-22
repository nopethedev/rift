import { route, HttpError } from "@/server/api";
import { musicWorker } from "@/server/music/worker";

export const dynamic = "force-dynamic";
export const GET = route<{ key: string }>("profile", async ({ params }) => {
  if (!/^[0-9a-f]{24}$/.test(params.key)) throw new HttpError(400, "Bad key");
  const s = (await musicWorker.status([params.key]))[params.key];
  if (!s) throw new HttpError(404, "Not prepared (or already cleaned up)");
  return s;
});
