import { route } from "@/server/api";
import { scanMusic } from "@/server/music/library";
import { invalidateMatchIndex } from "@/server/music/catalog";

export const POST = route("admin", async () => {
  void scanMusic().then(invalidateMatchIndex).catch(() => {}); // runs in the background; poll /status
  return { started: true };
});
