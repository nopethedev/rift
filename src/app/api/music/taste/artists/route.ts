import { z } from "zod";
import { route, parse } from "@/server/api";
import { db } from "@/server/db";
import { chartArtists, genres, onlineEnabled, searchCatalog } from "@/server/music/online";
import type { CatArtist } from "@/lib/music-types";

export const dynamic = "force-dynamic";
/** Artists to choose from during onboarding: the library's own artists, then popular ones (or a search). */
export const GET = route("profile", async ({ req }) => {
  const { q, genre } = parse(z.object({ q: z.string().trim().max(100).optional(), genre: z.string().regex(/^\d{1,12}$/).optional() }), Object.fromEntries(req.nextUrl.searchParams));
  const online = await onlineEnabled();
  if (q && q.length >= 2) {
    const lib = await db.musicTrack.groupBy({ by: ["artist"], where: { status: "ready", artist: { contains: q } }, _count: { _all: true }, orderBy: { _count: { artist: "desc" } }, take: 8 });
    const cat = online ? (await searchCatalog(q).catch(() => ({ artists: [] as CatArtist[] }))).artists : [];
    return { artists: merge(lib.map((a) => ({ id: "", name: a.artist, pictureUrl: null, fans: null })), cat) };
  }
  const lib = await db.musicTrack.groupBy({ by: ["artist"], where: { status: "ready", NOT: { artist: "Unknown artist" } }, _count: { _all: true }, orderBy: { _count: { artist: "desc" } }, take: 12 });
  const [cat, gs] = online ? await Promise.all([chartArtists(genre ?? "0", 40).catch(() => []), genres().catch(() => [])]) : [[], []];
  return { artists: merge(genre ? [] : lib.map((a) => ({ id: "", name: a.artist, pictureUrl: null, fans: null })), cat), genres: gs.map((x) => ({ id: x.id, name: x.name })), online };
});

function merge(a: CatArtist[], b: CatArtist[]): CatArtist[] {
  const seen = new Map<string, CatArtist>();
  for (const x of [...b, ...a]) { const k = x.name.toLowerCase(); const cur = seen.get(k); if (!cur) seen.set(k, x); else if (!cur.pictureUrl && x.pictureUrl) seen.set(k, { ...x }); }
  // Library artists first (they're yours), then the rest in the catalogue's order.
  const libNames = new Set(a.map((x) => x.name.toLowerCase()));
  return [...seen.values()].sort((x, y) => Number(libNames.has(y.name.toLowerCase())) - Number(libNames.has(x.name.toLowerCase())));
}
