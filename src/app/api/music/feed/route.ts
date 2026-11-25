import { route } from "@/server/api";
import { buildFeed } from "@/server/music/online";
import { musicTasteOf, recommend } from "@/server/music/taste";
import { musicMode } from "@/server/music/config";
import { getSettings } from "@/server/settings";
import type { CatTrack } from "@/lib/music-types";

export const dynamic = "force-dynamic";
/** Home shelves from the online catalogue: "Made for you" (taste profile), charts, new releases, "because you listen to …". */
export const GET = route("profile", async ({ profile, auth }) => {
  const t = await musicTasteOf(profile.id);
  const feed = await buildFeed({ artists: t.artists.map((a) => a.name), genres: t.genres.map((x) => x.name) });
  // Catalogue songs only play through on-demand sources: the mix is offered when those work.
  if (feed.enabled && musicMode(await getSettings(), auth.user).onDemand && (t.artists.length || t.genres.length)) {
    const recs = await recommend(profile.id, { n: 20, library: false, catalog: true }).catch(() => []);
    const tracks: CatTrack[] = recs.map((r) => ({ id: r.key, title: r.title, artist: r.artist, artistId: null, album: r.album, albumId: null, durationSec: r.durationSec ?? 0, artworkUrl: r.artworkUrl }));
    if (tracks.length >= 5) feed.shelves.unshift({ id: "mix", title: "Made for you", subtitle: recs[0]?.reason ? `${recs[0].reason}, and more like it` : "From what you listen to", tracks });
  }
  return feed;
});
