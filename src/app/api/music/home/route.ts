import { route } from "@/server/api";
import { getSettings } from "@/server/settings";
import { libraryStats } from "@/server/music/catalog";
import { musicMode } from "@/server/music/config";
import { homeSections } from "@/server/music/recommend";

export const dynamic = "force-dynamic";
export const GET = route("profile", async ({ auth, profile }) => {
  const mode = musicMode(await getSettings(), auth.user);
  return { mode, stats: await libraryStats(), ...(await homeSections(profile.id)) };
});
