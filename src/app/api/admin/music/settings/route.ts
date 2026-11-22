import { z } from "zod";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { route, body, HttpError } from "@/server/api";
import { getSettings, publicSettings, updateSettings, type Settings } from "@/server/settings";

export const dynamic = "force-dynamic";
const abs = z.string().trim().min(1).refine((p) => path.isAbsolute(p), "Must be an absolute path");
const node = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,32}$/i, "Node id: letters, digits, - and _"), name: z.string().trim().min(1).max(60),
  url: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), "Must be http(s)"), password: z.string().max(300), searchPrefix: z.string().trim().regex(/^[a-z]{2,20}$/i, "e.g. scsearch, ytsearch"),
});
const schema = z.object({
  musicSource: z.enum(["local", "ondemand", "hybrid"]), musicEngine: z.enum(["ytdlp", "lavalink"]),
  musicPreload: z.boolean(), musicPreloadCount: z.number().int().min(1).max(5),
  musicCacheDir: z.string().trim().max(500).refine((p) => !p || path.isAbsolute(p), "Must be an absolute path"),
  musicMaxCacheMB: z.number().int().min(64).max(10_000_000), musicCacheCleanup: z.boolean(), musicCleanupGraceSec: z.number().int().min(0).max(86400),
  musicFormat: z.enum(["mp3", "aac", "opus"]), musicBitrate: z.number().int().min(64).max(320),
  musicMaxStreams: z.number().int().min(0).max(500), musicMaxDownloads: z.number().int().min(1).max(16),
  musicOnDemandAccess: z.enum(["admins", "everyone"]), musicRightsAttested: z.boolean(), musicLicensePolicy: z.enum(["licensed-only", "attested"]),
  musicSearchProviders: z.array(z.enum(["youtube", "soundcloud"])).max(2),
  musicLibraryDirs: z.array(abs).min(1).max(20), musicUploadDir: abs,
  musicLavalinkNodes: z.array(node).max(20), musicLavalinkAllowedSources: z.array(z.string().trim().regex(/^[a-z0-9_-]{2,30}$/i)).max(30),
  musicLavalinkPlugins: z.array(z.object({ dependency: z.string().trim().regex(/^[\w.-]+:[\w.-]+:[\w.+-]+$/, "group:artifact:version"), repository: z.string().trim().max(300).refine((u) => !u || /^https?:\/\//.test(u), "Must be http(s)") })).max(20),
  spotifyClientId: z.string().trim().max(100), spotifyClientSecret: z.string().trim().max(200),
}).partial();

const MUSIC_KEYS = Object.keys(schema.shape) as (keyof Settings)[];
const pick = (s: Settings) => Object.fromEntries(MUSIC_KEYS.map((k) => [k, (publicSettings(s) as unknown as Record<string, unknown>)[k]]));

export const GET = route("admin", async () => ({ settings: pick(await getSettings()) }));

export const PUT = route("admin", async ({ req }) => {
  const d = await body(req, schema);
  const cur = await getSettings();
  const patch: Partial<Settings> = { ...d } as Partial<Settings>;
  if (d.spotifyClientSecret?.startsWith("••••")) delete patch.spotifyClientSecret;
  if (d.musicLavalinkNodes) {
    const ids = new Set<string>();
    patch.musicLavalinkNodes = d.musicLavalinkNodes.map((n) => {
      if (ids.has(n.id)) throw new HttpError(400, `Duplicate Lavalink node id "${n.id}"`);
      ids.add(n.id);
      // masked placeholder = keep the stored password of the node with that id
      const keep = n.password.startsWith("••••") ? cur.musicLavalinkNodes.find((c) => c.id === n.id)?.password ?? "" : n.password;
      return { ...n, password: keep || (n.id === "bundled" ? randomBytes(18).toString("base64url") : "") };
    });
  }
  const next = { ...cur, ...patch };
  if (next.musicSource !== "local" && next.musicEngine === "lavalink" && !next.musicLavalinkNodes.length) throw new HttpError(400, "Add a Lavalink node first, or pick yt-dlp as the on-demand engine.");
  for (const dir of [...(d.musicLibraryDirs ?? []), d.musicUploadDir].filter(Boolean) as string[]) {
    await mkdir(dir, { recursive: true }).catch((e) => { throw new HttpError(400, `Cannot create ${dir}: ${e.message}`); });
  }
  return { settings: pick(await updateSettings(patch)) };
});
