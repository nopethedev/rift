import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { getSettings } from "./settings";
import { artUrlAllowed } from "./music/art-hosts";

/**
 * Discord Rich Presence. Discord only accepts presence from the desktop app on the user's own computer, so the server
 * cannot set it directly. Instead it keeps each profile's "now playing" in memory and a tiny companion script
 * (public/rift-discord-presence.mjs, run on the PC with Discord) reads it with a per-profile secret token and shows it.
 */
export interface NowPlaying { kind: "music" | "video"; title: string; subtitle: string; album?: string | null; image?: string | null; position: number; duration: number; playing: boolean; at: number }

const g = globalThis as unknown as { __riftNow?: Map<string, NowPlaying>; __riftPresenceCfg?: Map<string, { at: number; v: PresenceCfg }>; __riftCompanionSeen?: Map<string, number> };
const nowMap = (g.__riftNow ??= new Map());
const cfgCache = (g.__riftPresenceCfg ??= new Map());
const seen = (g.__riftCompanionSeen ??= new Map());

export interface PresenceCfg { token: string | null; music: boolean; stream: boolean }
const CFG_TTL = 30_000;
const MUSIC_LIVE = 90_000; // the player re-sends every 30 s while playing
const PAUSED_KEEP = 10 * 60_000;
const VIDEO_LIVE = 45_000; // the video player posts progress every ~10 s

export async function presenceCfg(profileId: string): Promise<PresenceCfg> {
  const hit = cfgCache.get(profileId);
  if (hit && Date.now() - hit.at < CFG_TTL) return hit.v;
  const p = await db.profile.findUnique({ where: { id: profileId }, select: { presenceToken: true, presenceMusic: true, presenceStream: true } });
  const v: PresenceCfg = { token: p?.presenceToken ?? null, music: !!p?.presenceMusic, stream: !!p?.presenceStream };
  cfgCache.set(profileId, { at: Date.now(), v });
  return v;
}
export const dropPresenceCfg = (profileId: string) => { cfgCache.delete(profileId); };

export const newToken = () => `rp_${randomBytes(24).toString("base64url")}`;
export const setNow = (profileId: string, np: Omit<NowPlaying, "at">) => { nowMap.set(profileId, { ...np, at: Date.now() }); };
export const clearNow = (profileId: string, kind?: NowPlaying["kind"]) => { if (!kind || nowMap.get(profileId)?.kind === kind) nowMap.delete(profileId); };
export const markCompanionSeen = (profileId: string) => { seen.set(profileId, Date.now()); };
export const companionSeenAt = (profileId: string): number | null => seen.get(profileId) ?? null;

/** Only pictures Discord's servers can fetch: well-known public art hosts. Library covers live on this server and stay private. */
export const publicImage = (url: string | null | undefined): string | null => (url && /^https:\/\//i.test(url) && (artUrlAllowed(url) || /^https:\/\/image\.tmdb\.org\//.test(url)) ? url : null);

const clip = (s: string, n = 128) => { const t = s.replace(/\s+/g, " ").trim().slice(0, n); return t.length >= 2 ? t : `${t} `; }; // Discord wants 2..128 characters

export interface DiscordActivity {
  type: 2 | 3; details: string; state: string;
  timestamps?: { start: number; end?: number };
  assets?: { large_image?: string; large_text?: string };
}

/** The activity to show for a "now playing" entry, or null when it is stale / switched off. */
export function activityFor(np: NowPlaying | undefined, cfg: Pick<PresenceCfg, "music" | "stream">, now = Date.now()): DiscordActivity | null {
  if (!np) return null;
  if (np.kind === "music" ? !cfg.music : !cfg.stream) return null;
  const age = now - np.at;
  if (np.playing ? age > (np.kind === "music" ? MUSIC_LIVE : VIDEO_LIVE) : age > PAUSED_KEEP) return null;
  const a: DiscordActivity = { type: np.kind === "music" ? 2 : 3, details: clip(np.title), state: clip(np.playing ? np.subtitle : `${np.subtitle} (paused)`) };
  if (np.playing && np.duration > 0) {
    const start = Math.round(np.at - np.position * 1000);
    a.timestamps = { start, end: Math.round(start + np.duration * 1000) };
  }
  if (np.image || np.album) a.assets = { ...(np.image ? { large_image: np.image } : {}), ...(np.album ? { large_text: clip(np.album) } : {}) };
  return a;
}

export async function snapshot(profileId: string) {
  const cfg = await presenceCfg(profileId);
  const s = await getSettings();
  return { clientId: s.discordClientId, activity: s.discordClientId ? activityFor(nowMap.get(profileId), cfg) : null };
}
