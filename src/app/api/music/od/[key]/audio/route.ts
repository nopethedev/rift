import { route, HttpError } from "@/server/api";
import { proxyWorkerAudio } from "@/server/music/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** On-demand audio from the worker's cache: streams while it is still being captured, Range-seekable once complete. */
export const GET = route<{ key: string }>("profile", async ({ req, params }) => {
  if (!/^[0-9a-f]{24}$/.test(params.key)) throw new HttpError(400, "Bad key");
  return proxyWorkerAudio(`audio/${params.key}`, req);
});
