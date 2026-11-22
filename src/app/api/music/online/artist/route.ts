import { z } from "zod";
import { route, parse } from "@/server/api";
import { artistProfile, findArtist } from "@/server/music/online";
import { online } from "@/server/music/online-api";

export const dynamic = "force-dynamic";
/** Artist profile by Deezer id, or by name (`profile: null` when no confident match exists). */
export const GET = route("profile", async ({ req }) => {
  const q = parse(z.object({ id: z.string().regex(/^\d{1,12}$/).optional(), name: z.string().trim().min(1).max(200).optional() }).refine((v) => v.id || v.name, "id or name required"), Object.fromEntries(req.nextUrl.searchParams));
  return online(async () => {
    const id = q.id ?? (await findArtist(q.name!))?.id;
    return { profile: id ? await artistProfile(id) : null };
  });
}, { rate: { key: "music-artist", max: 60, windowMs: 60_000 } });
