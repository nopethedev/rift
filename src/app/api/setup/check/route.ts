import { z } from "zod";
import path from "node:path";
import { stat, statfs } from "node:fs/promises";
import { route, body, HttpError } from "@/server/api";
import { isSetupComplete } from "@/server/auth";
import { env } from "@/server/config";
import { probeFfmpeg } from "@/server/transcode";

/** Setup helper: validates a TMDB key, inspects paths and FFmpeg. Only usable before setup completes. */
export const POST = route(
  "none",
  async ({ req }) => {
    if (await isSetupComplete()) throw new HttpError(403, "Setup already completed");
    const d = await body(
      req,
      z.object({ tmdbApiKey: z.string().max(512).optional(), paths: z.array(z.string().max(1024)).max(20).optional(), ffmpeg: z.boolean().optional() }),
    );
    const out: Record<string, unknown> = {};
    if (d.tmdbApiKey) {
      const key = d.tmdbApiKey.trim();
      const url = new URL(env.tmdbBase + "/configuration");
      if (key.length <= 40) url.searchParams.set("api_key", key);
      const res = await fetch(url, { headers: key.length > 40 ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) }).catch(() => null);
      out.tmdb = res?.ok ? { ok: true } : { ok: false, error: res ? `TMDB rejected the key (HTTP ${res.status})` : "Could not reach TMDB" };
    }
    if (d.paths) {
      out.paths = await Promise.all(
        d.paths.map(async (p) => {
          if (!path.isAbsolute(p)) return { path: p, ok: false, error: "Must be an absolute path" };
          try {
            const s = await stat(p);
            if (!s.isDirectory()) return { path: p, ok: false, error: "Not a directory" };
            const f = await statfs(p);
            return { path: p, ok: true, exists: true, freeGB: Math.round((Number(f.bavail) * Number(f.bsize)) / 1e9) };
          } catch {
            return { path: p, ok: true, exists: false }; // will be created
          }
        }),
      );
    }
    if (d.ffmpeg) out.ffmpeg = await probeFfmpeg();
    return out;
  },
  { rate: { key: "setup-check", max: 40, windowMs: 10 * 60_000 } },
);
