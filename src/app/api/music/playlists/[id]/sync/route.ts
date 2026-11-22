import { route } from "@/server/api";
import { syncPlaylist } from "@/server/music/playlists";

export const maxDuration = 120;
export const POST = route<{ id: string }>("profile", async ({ params, auth, profile }) => syncPlaylist(profile.id, auth.user, params.id), { rate: { key: "music-sync", max: 10, windowMs: 60_000 } });
