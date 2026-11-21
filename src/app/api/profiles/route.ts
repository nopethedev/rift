import { z } from "zod";
import { db } from "@/server/db";
import { route, body, HttpError } from "@/server/api";
import { MAX_PROFILES } from "@/server/auth";
import { parseFavoriteGenres } from "@/lib/taste";
import { hashSecret } from "@/server/security";
import { avatarSchema, favoriteGenresSchema, pinSchema } from "@/server/validators";

export const GET = route("user", async ({ auth }) => {
  const profiles = await db.profile.findMany({ where: { userId: auth.user.id }, orderBy: { createdAt: "asc" } });
  return { max: MAX_PROFILES, profiles: profiles.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, isKids: p.isKids, hasPin: !!p.pinHash, favoriteGenres: parseFavoriteGenres(p.favoriteGenres) })) };
});

export const POST = route("user", async ({ req, auth }) => {
  const d = await body(
    req,
    z.object({ name: z.string().trim().min(1).max(24), avatar: avatarSchema, isKids: z.boolean().default(false), favoriteGenres: favoriteGenresSchema.optional(), pin: pinSchema.nullish() }),
  );
  const pinHash = d.pin ? await hashSecret(d.pin) : null;
  // Count + create in one transaction so two concurrent requests can't exceed the cap.
  const p = await db.$transaction(async (tx) => {
    if ((await tx.profile.count({ where: { userId: auth.user.id } })) >= MAX_PROFILES) throw new HttpError(409, `Maximum of ${MAX_PROFILES} profiles reached`);
    return tx.profile.create({ data: { userId: auth.user.id, name: d.name, avatar: d.avatar, isKids: d.isKids, pinHash, favoriteGenres: d.favoriteGenres?.length ? JSON.stringify(d.favoriteGenres) : null } });
  });
  return { id: p.id };
});
