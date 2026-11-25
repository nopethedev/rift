import { z } from "zod";
import { route, body } from "@/server/api";
import { db } from "@/server/db";
import { forgetTaste, parseMusicPicks, tasteSummary } from "@/server/music/taste";

export const dynamic = "force-dynamic";
/** The profile's music taste: what it learned (artists, genres, decades) and what was picked during onboarding. */
export const GET = route("profile", async ({ profile }) => {
  const p = await db.profile.findUnique({ where: { id: profile.id }, select: { musicOnboardedAt: true } });
  return { ...(await tasteSummary(profile.id)), onboarded: !!p?.musicOnboardedAt };
});

const artist = z.object({ id: z.string().max(40).nullish(), name: z.string().trim().min(1).max(200), pictureUrl: z.string().max(500).nullish() });
const genre = z.object({ id: z.string().max(40).nullish(), name: z.string().trim().min(1).max(80) });
export const PUT = route("profile", async ({ req, profile }) => {
  const b = await body(req, z.object({ artists: z.array(artist).max(30).optional(), genres: z.array(genre).max(12).optional(), onboarded: z.boolean().optional() }));
  const cur = parseMusicPicks((await db.profile.findUnique({ where: { id: profile.id }, select: { musicTaste: true } }))?.musicTaste);
  const next = { artists: b.artists ?? cur.artists, genres: b.genres ?? cur.genres };
  await db.profile.update({
    where: { id: profile.id },
    data: { musicTaste: JSON.stringify(next), ...(b.onboarded === undefined ? {} : { musicOnboardedAt: b.onboarded ? new Date() : null }) },
  });
  forgetTaste(profile.id);
  return { ok: true };
});
