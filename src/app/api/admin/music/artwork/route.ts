import { route } from "@/server/api";
import { fillMissingArtwork } from "@/server/music/artwork";

/** Admin: look up missing album art now (ignores the one-week retry delay). */
export const POST = route("admin", async () => ({ result: await fillMissingArtwork(true) }));
