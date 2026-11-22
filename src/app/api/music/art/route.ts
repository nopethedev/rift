import { route, HttpError } from "@/server/api";
import { artUrlAllowed } from "@/server/music/art-hosts";
import { fetchArt } from "@/server/music/artwork";

export const dynamic = "force-dynamic";
/** Cached proxy for remote artwork: the browser never talks to third-party image hosts. Allow-listed hosts only. */
export const GET = route("user", async ({ req }) => {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  if (u.length > 1500 || !artUrlAllowed(u)) throw new HttpError(400, "Unsupported image address");
  const img = await fetchArt(u);
  if (!img) throw new HttpError(404, "Image not available");
  return new Response(new Uint8Array(img.data), { headers: { "content-type": img.mime, "cache-control": "private, max-age=604800, immutable" } });
});
