import { z } from "zod";
import { route, parse } from "@/server/api";
import { findLyrics } from "@/server/music/lyrics";

export const dynamic = "force-dynamic";
/** Lyrics for a song (any source), via a Lavalink node with LavaLyrics. `lyrics: null` + `reason` when there are none. */
export const GET = route("profile", async ({ req }) => {
  const q = parse(z.object({ title: z.string().trim().min(1).max(300), artist: z.string().trim().max(300).default(""), durationSec: z.coerce.number().min(0).max(36000).optional() }), Object.fromEntries(req.nextUrl.searchParams));
  return findLyrics(q);
}, { rate: { key: "music-lyrics", max: 60, windowMs: 60_000 } });
