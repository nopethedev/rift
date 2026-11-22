import { readFile } from "node:fs/promises";
import path from "node:path";
import { route, HttpError } from "@/server/api";
import { coverDir } from "@/server/music/library";

export const dynamic = "force-dynamic";
export const GET = route<{ hash: string }>("user", async ({ params }) => {
  if (!/^[0-9a-f]{40}$/.test(params.hash)) throw new HttpError(400, "Bad cover id");
  const buf = await readFile(path.join(coverDir(), `${params.hash}.jpg`)).catch(() => null);
  if (!buf) throw new HttpError(404, "Cover not found");
  return new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
});
