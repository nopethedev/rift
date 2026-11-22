import { route, HttpError } from "@/server/api";
import { getAlbum } from "@/server/music/catalog";

export const dynamic = "force-dynamic";
export const GET = route<{ key: string }>("profile", async ({ params }) => {
  const a = await getAlbum(params.key);
  if (!a) throw new HttpError(404, "Album not found");
  return a;
});
