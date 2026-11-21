import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { selectProfile } from "@/server/auth";
import { hashSecret, verifySecret } from "@/server/security";
import { avatarSchema, favoriteGenresSchema, pinSchema } from "@/server/validators";
import { rateLimit, resetRateLimit } from "@/server/ratelimit";

type P = { id: string };

async function own(userId: string, id: string) {
  const p = await db.profile.findFirst({ where: { id, userId } });
  if (!p) throw new HttpError(404, "Profile not found");
  return p;
}

export const PATCH = route<P>("user", async ({ req, auth, params }) => {
  const p = await own(auth.user.id, params.id);
  const d = await body(
    req,
    z.object({
      name: z.string().trim().min(1).max(24).optional(),
      avatar: avatarSchema.optional(),
      isKids: z.boolean().optional(),
      favoriteGenres: favoriteGenresSchema.optional(),
      pin: pinSchema.nullish(), // null = remove PIN, undefined = keep
      currentPin: z.string().max(8).optional(),
    }),
  );
  if (p.pinHash && (d.pin !== undefined || d.name || d.avatar || d.isKids !== undefined || d.favoriteGenres !== undefined)) {
    // Editing a PIN-protected profile requires its PIN
    if (!d.currentPin || !(await verifySecret(d.currentPin, p.pinHash))) throw new HttpError(403, "Current PIN required");
  }
  await db.profile.update({
    where: { id: p.id },
    data: {
      name: d.name, avatar: d.avatar, isKids: d.isKids,
      favoriteGenres: d.favoriteGenres === undefined ? undefined : JSON.stringify(d.favoriteGenres),
      pinHash: d.pin === undefined ? undefined : d.pin === null ? null : await hashSecret(d.pin),
    },
  });
  return { ok: true };
});

export const DELETE = route<P>("user", async ({ req, auth, params }) => {
  const p = await own(auth.user.id, params.id);
  const count = await db.profile.count({ where: { userId: auth.user.id } });
  if (count <= 1) throw new HttpError(409, "You need at least one profile");
  if (p.pinHash) {
    const pin = req.nextUrl.searchParams.get("pin") ?? "";
    if (!(await verifySecret(pin, p.pinHash))) throw new HttpError(403, "Current PIN required");
  }
  await db.profile.delete({ where: { id: p.id } });
  await db.session.updateMany({ where: { userId: auth.user.id, profileId: p.id }, data: { profileId: null } });
  return { ok: true };
});

/** Select the active profile for this session (verifies the PIN when set). */
export const POST = route<P>("user", async ({ req, auth, params }) => {
  const p = await own(auth.user.id, params.id);
  if (p.pinHash) {
    const { pin } = await body(req, z.object({ pin: z.string().max(8).optional() }));
    const key = `pin:${auth.user.id}:${p.id}`;
    const wait = rateLimit(key, 5, 10 * 60_000);
    if (wait) throw new HttpError(429, `Too many PIN attempts. Try again in ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
    if (!pin || !(await verifySecret(pin, p.pinHash))) throw new HttpError(403, "Incorrect PIN");
    resetRateLimit(key);
  }
  await selectProfile(auth.sessionId, p.id);
  return { ok: true };
});
