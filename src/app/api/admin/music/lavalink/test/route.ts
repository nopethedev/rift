import { z } from "zod";
import { route, body } from "@/server/api";
import { getSettings } from "@/server/settings";
import { musicWorker } from "@/server/music/worker";

/** Connect to a Lavalink node from the worker and report its version, source managers and plugins. */
export const POST = route("admin", async ({ req }) => {
  const b = await body(req, z.object({ id: z.string().max(40), name: z.string().max(60).default("test"), url: z.string().url(), password: z.string().max(300), searchPrefix: z.string().max(20).default("scsearch") }));
  const password = b.password.startsWith("••••") ? (await getSettings()).musicLavalinkNodes.find((n) => n.id === b.id)?.password ?? "" : b.password;
  return musicWorker.lavalinkTest({ ...b, password });
});
