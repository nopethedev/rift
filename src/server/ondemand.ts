import "server-only";
import { HttpError } from "./api";
import type { AuthState } from "./auth";
import { getSettings } from "./settings";
import { getTorrentStreamer } from "./torrents/streamer";

/** May this account start on-demand streams? (feature on, and admin or the "everyone" policy). */
export async function onDemandAllowed(auth: Pick<AuthState, "user">): Promise<boolean> {
  const s = await getSettings();
  return s.onDemandMaxStreams > 0 && (auth.user.role === "ADMIN" || s.onDemandAccess === "everyone");
}

export async function requireOnDemand(auth: Pick<AuthState, "user">): Promise<void> {
  const s = await getSettings();
  if (s.onDemandMaxStreams < 1) throw new HttpError(403, "On-demand streaming is turned off on this server.");
  if (auth.user.role !== "ADMIN" && s.onDemandAccess !== "everyone") throw new HttpError(403, "On-demand streaming is limited to administrators on this server.");
}

/** Admins can reach any stream; everyone else only the ones they started. 404 (not 403) so ids can't be probed. */
export function requireStreamAccess(auth: Pick<AuthState, "user">, streamId: string): void {
  if (auth.user.role === "ADMIN") return;
  if (!getTorrentStreamer().isOwner(streamId, auth.user.id)) throw new HttpError(404, "Stream not found");
}
