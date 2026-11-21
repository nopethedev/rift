import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { hashSecret } from "@/server/security";
import { passwordSchema, usernameSchema } from "@/server/validators";

export const GET = route("admin", async () => {
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { profiles: true, sessions: true } } } });
  return {
    users: users.map((u) => ({
      id: u.id, username: u.username, role: u.role, disabled: u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      profiles: u._count.profiles, sessions: u._count.sessions,
    })),
  };
});

export const POST = route("admin", async ({ req }) => {
  const d = await body(req, z.object({ username: usernameSchema, password: passwordSchema, role: z.enum(["ADMIN", "USER"]).default("USER") }));
  const username = d.username.toLowerCase();
  if (await db.user.findUnique({ where: { username } })) throw new HttpError(409, "Username already taken");
  const u = await db.user.create({ data: { username, displayName: d.username, passwordHash: await hashSecret(d.password), role: d.role } });
  await db.profile.create({ data: { userId: u.id, name: d.username, avatar: "smile:sky" } });
  return { id: u.id };
});
