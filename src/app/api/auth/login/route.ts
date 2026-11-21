import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { createSession } from "@/server/auth";
import { hashSecret, verifySecret } from "@/server/security";
import { rateLimit, resetRateLimit } from "@/server/ratelimit";

// Verified against when the user does not exist so response time doesn't reveal valid usernames.
let dummyHash: Promise<string> | null = null;

export const POST = route(
  "none",
  async ({ req, ip }) => {
    const { username, password } = await body(req, z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }));
    const uname = username.trim().toLowerCase();
    const wait = rateLimit(`login-user:${uname}`, 8, 15 * 60_000);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });

    const user = await db.user.findUnique({ where: { username: uname } });
    const ok = await verifySecret(password, user?.passwordHash ?? (await (dummyHash ??= hashSecret("rift-dummy"))));
    if (!user || !ok || user.disabled) throw new HttpError(401, user?.disabled && ok ? "Account disabled" : "Invalid username or password");

    resetRateLimit(`login-user:${uname}`);
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await createSession(user.id, { userAgent: req.headers.get("user-agent"), ip });
    return { ok: true, role: user.role };
  },
  { rate: { key: "login-ip", max: 30, windowMs: 15 * 60_000 } },
);
