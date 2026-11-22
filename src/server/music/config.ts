import "server-only";
import { getSettings, type Settings } from "../settings";
import type { MusicConfig } from "@shared/music-protocol";

/** Settings -> the self-contained config the worker receives with every request. */
export function toWorkerConfig(s: Settings): MusicConfig {
  return {
    engine: s.musicEngine,
    cacheDir: s.musicCacheDir,
    maxCacheMB: s.musicMaxCacheMB,
    cleanup: s.musicCacheCleanup,
    cleanupGraceSec: s.musicCleanupGraceSec,
    format: s.musicFormat,
    bitrateKbps: s.musicBitrate,
    maxDownloads: s.musicMaxDownloads,
    maxStreams: s.musicMaxStreams,
    // "attested" only counts when the admin ticked the rights confirmation.
    licensePolicy: s.musicLicensePolicy === "attested" && s.musicRightsAttested ? "attested" : "licensed-only",
    ytdlp: { providers: s.musicSearchProviders, binary: "" },
    lavalink: { nodes: s.musicLavalinkNodes, allowedSources: s.musicLavalinkAllowedSources },
  };
}

export async function getWorkerConfig(): Promise<MusicConfig> {
  return toWorkerConfig(await getSettings());
}

export interface MusicMode {
  source: Settings["musicSource"];
  /** Library playback is possible. */
  local: boolean;
  /** On-demand playback is switched on, attested and has an engine to use. */
  onDemand: boolean;
  /** Why on-demand is unavailable although the mode asks for it. */
  onDemandReason?: string;
}

export function musicMode(s: Settings, user: { role: "ADMIN" | "USER" }): MusicMode {
  const wants = s.musicSource !== "local";
  let reason: string | undefined;
  if (wants) {
    if (!s.musicRightsAttested) reason = "On-demand streaming is waiting for the administrator to confirm the rights to the enabled sources.";
    else if (s.musicOnDemandAccess === "admins" && user.role !== "ADMIN") reason = "On-demand streaming is limited to administrators.";
    else if (s.musicEngine === "lavalink" && !s.musicLavalinkNodes.length) reason = "No Lavalink node is configured.";
  }
  return { source: s.musicSource, local: s.musicSource !== "ondemand", onDemand: wants && !reason, onDemandReason: reason };
}
