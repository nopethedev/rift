import { route, HttpError } from "@/server/api";
import { charts, genres } from "@/server/music/online";
import { online } from "@/server/music/online-api";

export const dynamic = "force-dynamic";
export const GET = route<{ id: string }>("profile", async ({ params }) => {
  if (!/^\d{1,6}$/.test(params.id)) throw new HttpError(400, "Bad genre id");
  return online(async () => {
    const [c, all] = await Promise.all([charts(params.id), genres()]);
    const g = all.find((x) => x.id === params.id);
    if (!g) throw new HttpError(404, "Genre not found");
    return { genre: g, ...c };
  });
});
