import { route, HttpError } from "@/server/api";
import { defaultSettings, getSettings, updateSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/**
 * After the YouTube sign-in on the bundled node, read the refresh token from the youtube-source plugin (GET /youtube)
 * and keep it in Rift's settings, so the next "write config" puts it in application.yml and the sign-in survives restarts.
 */
export const POST = route("admin", async () => {
  const s = await getSettings();
  const node = s.musicLavalinkNodes.find((n) => n.id === "bundled") ?? s.musicLavalinkNodes[0];
  if (!node) throw new HttpError(400, "No Lavalink node is configured.");
  const r = await fetch(`${node.url.replace(/\/$/, "")}/youtube`, { headers: { Authorization: node.password }, signal: AbortSignal.timeout(8000) })
    .catch((e: Error) => { throw new HttpError(502, `Could not reach ${node.name}: ${e.message}`); });
  if (r.status === 404) return { saved: false, note: `${node.name} has no YouTube plugin endpoint. Write the config with YouTube on and restart lavalink first.` };
  if (!r.ok) throw new HttpError(502, `${node.name} answered ${r.status}`);
  const body = (await r.json().catch(() => ({}))) as { refreshToken?: string | null };
  if (!body.refreshToken) return { saved: false, note: "The node isn't signed in yet. Open the google.com/device link from `docker compose logs lavalink`, enter the code, wait a few seconds and try again." };
  const yt = { ...defaultSettings().musicLavalinkYoutube, ...s.musicLavalinkYoutube, oauth: true, refreshToken: body.refreshToken };
  await updateSettings({ musicLavalinkYoutube: yt });
  return { saved: true, note: "Saved the YouTube refresh token. Press “Save & write Lavalink config” once more so it's kept across restarts." };
});
