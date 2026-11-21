import { route } from "@/server/api";
import { listSearchProviders } from "@/server/torrents/search";

export const GET = route("admin", async () => ({ providers: await listSearchProviders() }));
