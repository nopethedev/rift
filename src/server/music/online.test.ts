import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({ getSettings: async () => ({ musicMetadata: true }) }));
process.env.DEEZER_API_URL = "http://dz.test";
process.env.WIKIPEDIA_API_URL = "http://wiki.test";
process.env.ITUNES_API_URL = "http://it.test";
const { artistBio, artistProfile, charts, clearOnlineCache, findAlbumArt, findArtist, OnlineError } = await import("./online");

const calls: string[] = [];
let routes: Record<string, unknown> = {};
beforeEach(() => {
  calls.length = 0;
  clearOnlineCache();
  vi.stubGlobal("fetch", async (u: string | URL) => {
    const url = String(u);
    calls.push(url);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.entries(routes).find(([k]) => path === k || path.startsWith(k + "?"));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
  });
});

const D = (data: unknown[]) => ({ data });
const art = { id: 7, name: "Daft Punk", nb_fan: 5, nb_album: 4, picture_xl: "https://cdn.dzcdn.net/images/artist/abc/1000x1000.jpg" };

describe("catalogue mapping", () => {
  it("maps charts, drops unplayable rows and placeholder pictures", async () => {
    routes = { "/chart/0": { tracks: D([{ id: 1, title: "One More Time", duration: 320, artist: { id: 7, name: "Daft Punk" }, album: { id: 9, title: "Discovery", cover_xl: "https://cdn.dzcdn.net/images/cover/c/1000x1000.jpg" } }, { id: 2, title: "", artist: { name: "x" } }]), albums: D([]), artists: D([{ id: 8, name: "Ghost", picture_xl: "https://e-cdns-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg" }]) } };
    const c = await charts();
    expect(c.tracks).toHaveLength(1);
    expect(c.tracks[0]).toMatchObject({ id: "1", title: "One More Time", artist: "Daft Punk", artistId: "7", album: "Discovery", albumId: "9", durationSec: 320 });
    expect(c.tracks[0].artworkUrl).toMatch(/dzcdn/);
    expect(c.artists[0].pictureUrl).toBeNull();
  });

  it("caches identical requests", async () => {
    routes = { "/chart/0": { tracks: D([]), albums: D([]), artists: D([]) } };
    await charts(); await charts(); await Promise.all([charts(), charts()]);
    expect(calls).toHaveLength(1);
  });

  it("turns Deezer's 200-with-error body and HTTP failures into OnlineError", async () => {
    routes = { "/artist/5": { error: { type: "DataException", message: "no data", code: 800 } } };
    await expect(artistProfile("5")).rejects.toBeInstanceOf(OnlineError);
    routes = {};
    await expect(charts()).rejects.toThrow(/answered 404/);
    await expect(artistProfile("not-a-number")).rejects.toThrow(/Bad artist id/);
  });
});

describe("artists", () => {
  it("findArtist only accepts an exact (normalised) name match, preferring the most popular", async () => {
    routes = { "/search/artist": D([{ id: 1, name: "Daft Punks", nb_fan: 99 }, { id: 2, name: "daft punk", nb_fan: 3 }, { id: 3, name: "Daft Punk", nb_fan: 500 }]) };
    expect((await findArtist("Daft Punk"))?.id).toBe("3");
    routes = { "/search/artist": D([{ id: 1, name: "Daft Punks", nb_fan: 99 }]) };
    clearOnlineCache();
    expect(await findArtist("Daft Punk")).toBeNull();
  });

  it("biography: music pages are used, disambiguation / unrelated pages are not", async () => {
    routes = { "/api/rest_v1/page/summary/Daft_Punk": { type: "standard", description: "French electronic music duo", extract: "Daft Punk were a duo.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Daft_Punk" } } } };
    expect(await artistBio("Daft Punk")).toEqual({ text: "Daft Punk were a duo.", url: "https://en.wikipedia.org/wiki/Daft_Punk" });
    clearOnlineCache();
    routes = { "/api/rest_v1/page/summary/Mercury": { type: "standard", description: "Planet", extract: "Mercury is the smallest planet." }, "/api/rest_v1/page/summary/Mercury_(band)": { type: "disambiguation", extract: "x" } };
    expect(await artistBio("Mercury")).toBeNull();
  });

  it("artist profile: merges duplicate album titles, newest first", async () => {
    routes = {
      "/artist/7": art,
      "/artist/7/top": D([{ id: 1, title: "Around the World", duration: 200, artist: { id: 7, name: "Daft Punk" }, album: { id: 1, title: "Homework" } }]),
      "/artist/7/albums": D([{ id: 1, title: "Homework", release_date: "1997-01-20", record_type: "album" }, { id: 2, title: "Discovery", release_date: "2001-03-12", record_type: "album" }, { id: 3, title: "discovery", release_date: "2001-03-13", record_type: "album" }, { id: 4, title: "Get Lucky", release_date: "2013-04-19", record_type: "single" }]),
      "/artist/7/related": D([{ id: 9, name: "Justice" }]),
    };
    const p = await artistProfile("7");
    expect(p.albums.map((a) => a.title)).toEqual(["Get Lucky", "Discovery", "Homework"]);
    expect(p.albums[0].kind).toBe("single");
    expect(p.related[0].name).toBe("Justice");
    expect(p.bio).toBeNull(); // wikipedia route absent: not an error
    expect(p.artist).toMatchObject({ name: "Daft Punk", fans: 5, albums: 4 });
  });
});

describe("findAlbumArt", () => {
  it("uses the album match, requires the right artist, falls back to iTunes", async () => {
    routes = { "/search/album": D([{ id: 1, title: "Discovery", artist: { name: "Someone Else" }, cover_xl: "https://cdn.dzcdn.net/images/cover/wrong/1000x1000.jpg" }, { id: 2, title: "Discovery", artist: { name: "Daft Punk" }, cover_xl: "https://cdn.dzcdn.net/images/cover/right/1000x1000.jpg" }]) };
    expect(await findAlbumArt({ artist: "Daft Punk", album: "Discovery" })).toMatch(/right/);
    clearOnlineCache();
    routes = { "/search/album": D([]), "/search/track": D([]), "/search": { results: [{ collectionName: "Discovery", artistName: "Daft Punk", artworkUrl100: "https://is1.mzstatic.com/image/thumb/Music/100x100bb.jpg" }] } };
    expect(await findAlbumArt({ artist: "Daft Punk", album: "Discovery" })).toBe("https://is1.mzstatic.com/image/thumb/Music/600x600bb.jpg");
    clearOnlineCache();
    routes = { "/search/album": D([]), "/search/track": D([]), "/search": { results: [] } };
    expect(await findAlbumArt({ artist: "Nobody", album: "Nothing" })).toBeNull();
  });
});
