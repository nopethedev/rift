import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { hashSecret } from "@/server/security";
import { passwordSchema } from "@/server/validators";

type P = { id: string };

async function guardLastAdmin(id: string, change: "demote" | "disable" | "delete") {
  const u = await db.user.findUnique({ where: { id } });
  if (!u) throw new HttpError(404, "User not found");
  if (u.role === "ADMIN" && !u.disabled) {
    const others = await db.user.count({ where: { role: "ADMIN", disabled: false, id: { not: id } } });
    if (!others) throw new HttpError(409, `Cannot ${change} the last active administrator`);
  }
  return u;
}

export const PATCH = route<P>("admin", async ({ req, params }) => {
  const d = await body(req, z.object({ role: z.enum(["ADMIN", "USER"]).optional(), disabled: z.boolean().optional(), password: passwordSchema.optional() }));
  if (d.role === "USER") await guardLastAdmin(params.id, "demote");
  if (d.disabled) await guardLastAdmin(params.id, "disable");
  const user = await db.user.findUnique({ where: { id: params.id } });
  if (!user) throw new HttpError(404, "User not found");
  await db.user.update({
    where: { id: params.id },
    data: { role: d.role, disabled: d.disabled, passwordHash: d.password ? await hashSecret(d.password) : undefined },
  });
  // Password reset or disable invalidates existing sessions
  if (d.password || d.disabled) await db.session.deleteMany({ where: { userId: params.id } });
  return { ok: true };
});

export const DELETE = route<P>("admin", async ({ params, auth }) => {
  if (params.id === auth.user.id) throw new HttpError(409, "You cannot delete your own account");
  await guardLastAdmin(params.id, "delete");
  await db.user.delete({ where: { id: params.id } });
  return { ok: true };
});
