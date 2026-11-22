import { z } from "zod";
import { route, parse } from "@/server/api";
import { listAlbums, listArtists, listTracks } from "@/server/music/catalog";

export const dynamic = "force-dynamic";
export const GET = route("profile", async ({ req }) => {
  const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), Object.fromEntries(req.nextUrl.searchParams));
  const [tracks, albums, artists] = await Promise.all([listTracks({ q, take: 30 }), listAlbums({ q, take: 12 }), listArtists({ q, take: 12 })]);
  return { tracks: tracks.tracks, albums, artists };
}, { rate: { key: "music-search", max: 60, windowMs: 60_000 } });
