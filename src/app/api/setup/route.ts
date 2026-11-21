import { z } from "zod";
import path from "node:path";
import { mkdir, access, constants } from "node:fs/promises";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { createSession, isSetupComplete } from "@/server/auth";
import { hashSecret } from "@/server/security";
import { updateSettings, defaultSettings } from "@/server/settings";
import { passwordSchema, usernameSchema } from "@/server/validators";

const schema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  serverName: z.string().trim().min(1).max(40).default("Rift"),
  tmdbApiKey: z.string().trim().max(512).default(""),
  libraryDirs: z.array(z.string().trim().min(1)).min(1).max(20),
  downloadDir: z.string().trim().min(1),
  storageLimitGB: z.number().min(0).max(1_000_000).default(0),
  hwaccel: z.enum(["none", "auto", "nvenc", "vaapi", "qsv", "videotoolbox"]).default("none"),
});

export const POST = route(
  "none",
  async ({ req, ip }) => {
    if (await isSetupComplete()) throw new HttpError(403, "Setup already completed");
    const d = await body(req, schema);
    for (const dir of [...d.libraryDirs, d.downloadDir]) {
      if (!path.isAbsolute(dir)) throw new HttpError(400, `Path must be absolute: ${dir}`);
      await mkdir(dir, { recursive: true }).catch((e) => {
        throw new HttpError(400, `Cannot create ${dir}: ${e.message}`);
      });
      await access(dir, constants.W_OK).catch(() => {
        throw new HttpError(400, `Directory not writable: ${dir}`);
      });
    }
    const hash = await hashSecret(d.password);
    // Re-check inside the create to avoid a race between two setup submissions.
    const user = await db.$transaction(async (tx) => {
      if ((await tx.user.count()) > 0) throw new HttpError(403, "Setup already completed");
      const u = await tx.user.create({ data: { username: d.username.toLowerCase(), displayName: d.username, passwordHash: hash, role: "ADMIN" } });
      await tx.profile.create({ data: { userId: u.id, name: d.username, avatar: "crown:violet" } });
      return u;
    });
    const base = defaultSettings();
    await updateSettings({
      setupComplete: true,
      serverName: d.serverName,
      tmdbApiKey: d.tmdbApiKey,
      libraryDirs: d.libraryDirs,
      downloadDir: d.downloadDir,
      uploadDir: path.join(d.libraryDirs[0], "uploads"),
      storageLimitGB: d.storageLimitGB,
      hwaccel: d.hwaccel,
      maxActiveDownloads: base.maxActiveDownloads,
    });
    await mkdir(path.join(d.libraryDirs[0], "uploads"), { recursive: true }).catch(() => {});
    await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    return { ok: true };
  },
  { rate: { key: "setup", max: 10, windowMs: 10 * 60_000 } },
);
