import { route } from "@/server/api";
import { getSettings } from "@/server/settings";
import { lavalinkConfigDir, renderLavalinkConfig, writeLavalinkConfig } from "@/server/music/lavalink-config";

export const dynamic = "force-dynamic";
export const GET = route("admin", async () => ({ dir: lavalinkConfigDir(), yaml: renderLavalinkConfig(await getSettings()).replace(/^(\s*(?:password|refreshToken|token|visitorData): )".*"$/gm, '$1"••••"') }));
/** Writes the bundled node's application.yml (password + plugins) into the shared config volume. */
export const POST = route("admin", async () => ({ file: await writeLavalinkConfig(await getSettings()), note: "Restart the lavalink container to apply plugin changes." }));
