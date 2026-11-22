import { z } from "zod";
import { route, parse } from "@/server/api";
import { listAlbums, listArtists, listTracks } from "@/server/music/catalog";

export const dynamic = "force-dynamic";
const q = z.object({
  kind: z.enum(["tracks", "albums", "artists"]).default("tracks"), q: z.string().max(200).optional(), artist: z.string().max(300).optional(), albumKey: z.string().max(40).optional(),
  genre: z.string().max(100).optional(), take: z.coerce.number().int().min(1).max(500).optional(), skip: z.coerce.number().int().min(0).optional(), recent: z.coerce.boolean().optional(),
});

export const GET = route("profile", async ({ req }) => {
  const p = parse(q, Object.fromEntries(req.nextUrl.searchParams));
  if (p.kind === "albums") return { albums: await listAlbums(p) };
  if (p.kind === "artists") return { artists: await listArtists(p) };
  return listTracks(p);
});
