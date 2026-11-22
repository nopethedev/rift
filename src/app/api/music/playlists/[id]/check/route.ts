import { route } from "@/server/api";
import { checkStatus, startCheck, getPlaylist } from "@/server/music/playlists";

export const dynamic = "force-dynamic";
/** Re-check which entries can be played (library, then on-demand sources). Runs in the background; poll GET. */
export const POST = route<{ id: string }>("profile", async ({ params, auth, profile }) => {
  await getPlaylist(profile.id, params.id);
  return startCheck(profile.id, auth.user, params.id, true);
});
export const GET = route<{ id: string }>("profile", async ({ params, profile }) => {
  await getPlaylist(profile.id, params.id);
  return checkStatus(params.id) ?? { running: false, done: 0, total: 0 };
});
