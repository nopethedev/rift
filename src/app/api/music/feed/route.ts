import { route } from "@/server/api";
import { buildFeed } from "@/server/music/online";
import { tasteOf } from "@/server/music/recommend";

export const dynamic = "force-dynamic";
/** Home shelves from the online catalogue (charts, new releases, "because you listened to …"). */
export const GET = route("profile", async ({ profile }) => {
  const t = await tasteOf(profile.id);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return buildFeed({ artists: top(t.artists).filter((a) => a && a !== "Unknown artist"), genres: top(t.genres) });
});
