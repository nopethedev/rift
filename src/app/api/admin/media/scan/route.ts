import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { route, parse, HttpError } from "@/server/api";
import { getScanStatus, scanNow } from "@/server/library/scanner";

export const GET = route("admin", async () => ({ status: getScanStatus() }));

/** Start a library scan in the background (returns immediately). Optional `dir` imports an arbitrary server folder. */
export const POST = route("admin", async ({ req }) => {
  const raw = await req.json().catch(() => ({}));
  const { dir } = parse(z.object({ dir: z.string().trim().min(1).max(2000).optional() }), raw ?? {});
  if (dir) {
    if (!path.isAbsolute(dir)) throw new HttpError(400, "Folder must be an absolute path");
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, "Folder does not exist or is not a directory");
  }
  if (getScanStatus().running) throw new HttpError(409, "A scan is already running");
  void scanNow(dir ? [dir] : undefined).catch((e) => console.error("[scan]", e));
  return { started: true, status: getScanStatus() };
});
