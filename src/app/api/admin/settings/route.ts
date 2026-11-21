import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { route, body, HttpError } from "@/server/api";
import { getSettings, publicSettings, updateSettings, type Settings } from "@/server/settings";
import { probeFfmpeg } from "@/server/transcode";

const abs = z.string().trim().min(1).refine((p) => path.isAbsolute(p), "Must be an absolute path");

const schema = z.object({
  serverName: z.string().trim().min(1).max(40),
  tmdbApiKey: z.string().trim().max(512),
  tmdbLanguage: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  libraryDirs: z.array(abs).min(1).max(20),
  downloadDir: abs,
  uploadDir: abs,
  storageLimitGB: z.number().min(0).max(1_000_000),
  maxActiveDownloads: z.number().int().min(1).max(20),
  downloadLimitKBps: z.number().int().min(0),
  uploadLimitKBps: z.number().int().min(0),
  autoImportDownloads: z.boolean(),
  hwaccel: z.enum(["none", "auto", "nvenc", "vaapi", "qsv", "videotoolbox"]),
  transcodeLadder: z.array(z.number().int().min(144).max(4320)).min(1).max(5),
  maxTranscodeJobs: z.number().int().min(1).max(16),
  enforceMediabunnyAudio: z.boolean(),
  torrentSearchProviders: z.array(z.string().max(40)).max(30),
  torznabUrl: z.string().trim().max(500).refine((u) => !u || /^https?:\/\//.test(u), "Must be an http(s) URL"),
  torznabApiKey: z.string().trim().max(200),
  sessionDays: z.number().int().min(1).max(365),
  opensubtitlesApiKey: z.string().trim().max(200),
  opensubtitlesUsername: z.string().trim().max(100),
  opensubtitlesPassword: z.string().max(200),
  onDemandMaxStreams: z.number().int().min(0).max(50),
  onDemandAccess: z.enum(["admins", "everyone"]),
  subtitleLanguages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/)).min(1).max(8),
}).partial();

export const GET = route("admin", async () => ({ settings: publicSettings(await getSettings()), ffmpeg: await probeFfmpeg() }));

export const PUT = route("admin", async ({ req }) => {
  const d = await body(req, schema);
  const patch: Partial<Settings> = { ...d };
  // Redacted placeholders from the UI mean "unchanged"
  if (d.tmdbApiKey?.startsWith("••••")) delete patch.tmdbApiKey;
  if (d.torznabApiKey?.startsWith("••••")) delete patch.torznabApiKey;
  if (d.opensubtitlesApiKey?.startsWith("••••")) delete patch.opensubtitlesApiKey;
  if (d.opensubtitlesPassword?.startsWith("••••")) delete patch.opensubtitlesPassword;
  for (const dir of [...(d.libraryDirs ?? []), d.downloadDir, d.uploadDir].filter(Boolean) as string[]) {
    await mkdir(dir, { recursive: true }).catch((e) => { throw new HttpError(400, `Cannot create ${dir}: ${e.message}`); });
  }
  if (d.transcodeLadder) patch.transcodeLadder = [...new Set(d.transcodeLadder)].sort((a, b) => b - a);
  return { settings: publicSettings(await updateSettings(patch)) };
});
