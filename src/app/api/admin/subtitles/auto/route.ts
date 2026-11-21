import { z } from "zod";
import { body, route } from "@/server/api";
import { autoFetchForTitle } from "@/server/subtitle-service";

/** Fetch the best subtitle in every preferred language for all files of a title that lack one. */
export const POST = route("admin", async ({ req }) => {
  const { titleId } = await body(req, z.object({ titleId: z.string().min(1).max(64) }));
  return { report: await autoFetchForTitle(titleId) };
}, { rate: { key: "os-auto", max: 6, windowMs: 60_000 } });
