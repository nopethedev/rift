import "server-only";
import { db } from "./db";
import { env } from "./config";
import path from "node:path";

export interface Settings {
  setupComplete: boolean;
  serverName: string;
  tmdbApiKey: string;
  tmdbLanguage: string;
  /** Directories scanned for media (absolute paths). */
  libraryDirs: string[];
  /** Where torrents are saved (usually inside a library dir so they get scanned). */
  downloadDir: string;
  /** Where uploads are stored. */
  uploadDir: string;
  /** Max combined size (GB) of the download dir. 0 = unlimited. */
  storageLimitGB: number;
  maxActiveDownloads: number;
  downloadLimitKBps: number; // 0 = unlimited
  uploadLimitKBps: number; // 0 = unlimited
  autoImportDownloads: boolean;
  hwaccel: "none" | "auto" | "nvenc" | "vaapi" | "qsv" | "videotoolbox";
  /** HLS ladder heights, descending. */
  transcodeLadder: number[];
  maxTranscodeJobs: number;
  /** Never transcode DD/DD+ audio on the server when the video is natively playable: the browser does it via Mediabunny. */
  enforceMediabunnyAudio: boolean;
  /** torrent-search-api provider names enabled for the wizard search. */
  torrentSearchProviders: string[];
  torznabUrl: string;
  torznabApiKey: string;
  sessionDays: number;
  /** OpenSubtitles.com (REST API v1): API key from the account's "API consumers" page, plus the account login for downloads. */
  opensubtitlesApiKey: string;
  opensubtitlesUsername: string;
  opensubtitlesPassword: string;
  /** On-demand streaming (torrent -> player, temporary cache): max simultaneous streams (0 = off) and who may start one. */
  onDemandMaxStreams: number;
  onDemandAccess: "admins" | "everyone";
  /** ISO 639-1 codes searched / auto-fetched, in order of preference. */
  subtitleLanguages: string[];
}

export const defaultSettings = (): Settings => ({
  setupComplete: false,
  serverName: "Rift",
  tmdbApiKey: env.tmdbKey,
  tmdbLanguage: "en-US",
  libraryDirs: [env.mediaDir],
  downloadDir: path.join(env.mediaDir, "downloads"),
  uploadDir: path.join(env.mediaDir, "uploads"),
  storageLimitGB: 0,
  maxActiveDownloads: 3,
  downloadLimitKBps: 0,
  uploadLimitKBps: 0,
  autoImportDownloads: true,
  hwaccel: "none",
  transcodeLadder: [1080, 720, 480],
  maxTranscodeJobs: 2,
  enforceMediabunnyAudio: true,
  torrentSearchProviders: ["1337x", "ThePirateBay"],
  torznabUrl: "",
  torznabApiKey: "",
  sessionDays: 30,
  opensubtitlesApiKey: env.opensubtitlesKey,
  opensubtitlesUsername: "",
  opensubtitlesPassword: "",
  subtitleLanguages: ["en"],
  onDemandMaxStreams: Math.max(0, Number(process.env.STREAM_MAX_SESSIONS) || 3),
  onDemandAccess: "admins",
});

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const rows = await db.setting.findMany();
  const value = defaultSettings() as unknown as Record<string, unknown>;
  for (const r of rows) {
    try { value[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row */ }
  }
  if (!value.tmdbApiKey) value.tmdbApiKey = env.tmdbKey;
  if (!value.opensubtitlesApiKey) value.opensubtitlesApiKey = env.opensubtitlesKey;
  cache = { at: Date.now(), value: value as unknown as Settings };
  return cache.value;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  await db.$transaction(
    Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) =>
        db.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } }),
      ),
  );
  cache = null;
  return getSettings();
}

/** Redacted version safe to send to the browser. */
export function publicSettings(s: Settings) {
  return { ...s, tmdbApiKey: s.tmdbApiKey ? "••••" + s.tmdbApiKey.slice(-4) : "", torznabApiKey: s.torznabApiKey ? "••••" : "", opensubtitlesApiKey: s.opensubtitlesApiKey ? "••••" + s.opensubtitlesApiKey.slice(-4) : "", opensubtitlesPassword: s.opensubtitlesPassword ? "••••" : "" };
}
