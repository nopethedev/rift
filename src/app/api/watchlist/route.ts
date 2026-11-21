import { z } from "zod";
import { db } from "@/server/db";
import { route, body } from "@/server/api";
import { mediaTypeSchema } from "@/server/validators";

const item = z.object({
  tmdbId: z.number().int().positive(),
  mediaType: mediaTypeSchema,
  title: z.string().max(300).default(""),
  posterPath: z.string().max(200).nullish(),
});

export const GET = route("profile", async ({ profile }) => {
  const rows = await db.watchlistItem.findMany({ where: { profileId: profile.id }, orderBy: { createdAt: "desc" } });
  return { items: rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType })) };
});

export const POST = route("profile", async ({ req, profile }) => {
  const d = await body(req, item);
  await db.watchlistItem.upsert({
    where: { profileId_tmdbId_mediaType: { profileId: profile.id, tmdbId: d.tmdbId, mediaType: d.mediaType } },
    create: { profileId: profile.id, tmdbId: d.tmdbId, mediaType: d.mediaType, title: d.title, posterPath: d.posterPath ?? null },
    update: {},
  });
  return { ok: true };
});

export const DELETE = route("profile", async ({ req, profile }) => {
  const d = await body(req, item.pick({ tmdbId: true, mediaType: true }));
  await db.watchlistItem.deleteMany({ where: { profileId: profile.id, tmdbId: d.tmdbId, mediaType: d.mediaType } });
  return { ok: true };
});
