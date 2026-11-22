import { describe, expect, it } from "vitest";
import { mapApiTrack, mapEmbed, parseSpotifyUrl } from "./spotify";

describe("parseSpotifyUrl", () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  it.each([
    [`https://open.spotify.com/playlist/${id}`, "playlist"],
    [`https://open.spotify.com/playlist/${id}?si=abc123`, "playlist"],
    [`https://open.spotify.com/intl-de/playlist/${id}`, "playlist"],
    [`https://open.spotify.com/embed/playlist/${id}`, "playlist"],
    [`spotify:playlist:${id}`, "playlist"],
    [`https://open.spotify.com/album/${id}`, "album"],
  ])("%s", (url, kind) => expect(parseSpotifyUrl(url)).toEqual({ kind, id }));
  it.each(["", "https://example.com/playlist/" + "a".repeat(22), "https://open.spotify.com/track/" + "a".repeat(22), "not a url", "https://open.spotify.com/playlist/short"])("rejects %s", (u) => expect(parseSpotifyUrl(u)).toBeNull());
});

describe("mapApiTrack", () => {
  it("maps fields, joins artists and skips local files", () => {
    expect(mapApiTrack({ id: "t1", name: "Song", duration_ms: 200_400, artists: [{ name: "A" }, { name: "B" }], album: { name: "Alb", images: [{ url: "big" }, { url: "small" }] }, external_ids: { isrc: "USX" } }))
      .toEqual({ externalId: "t1", title: "Song", artist: "A, B", album: "Alb", durationSec: 200, artworkUrl: "small", isrc: "USX" });
    expect(mapApiTrack({ name: "Local", is_local: true })).toBeNull();
    expect(mapApiTrack(null)).toBeNull();
  });
});

describe("mapEmbed", () => {
  const page = (entity: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
  it("reads the playlist from the embed page data, keeping order", () => {
    const r = mapEmbed(page({ name: "Road Trip", coverArt: { sources: [{ url: "http://img/1" }] }, trackList: [
      { uri: "spotify:track:aaa", title: "First", subtitle: "Artist One", duration: 181000 },
      { uri: "spotify:track:bbb", title: "Second", subtitle: "Two, Three", duration: 99000 },
      { title: "" },
    ] }), "playlist", "x".repeat(22));
    expect(r.name).toBe("Road Trip");
    expect(r.artworkUrl).toBe("http://img/1");
    expect(r.tracks).toEqual([
      { externalId: "aaa", title: "First", artist: "Artist One", durationSec: 181 },
      { externalId: "bbb", title: "Second", artist: "Two, Three", durationSec: 99 },
    ]);
    expect(r.truncated).toBe(false);
    expect(r.via).toBe("embed");
  });
  it("flags the 100-track embed limit", () => {
    const list = Array.from({ length: 100 }, (_, i) => ({ uri: `spotify:track:${i}`, title: `T${i}`, subtitle: "A", duration: 1000 }));
    expect(mapEmbed(page({ name: "Big", trackList: list }), "playlist", "x".repeat(22)).truncated).toBe(true);
  });
  it("fails clearly for private/unreadable pages", () => {
    expect(() => mapEmbed("<html></html>", "playlist", "x")).toThrow(/Could not read/);
    expect(() => mapEmbed(page({ name: "No tracks" }), "playlist", "x")).toThrow(/private/);
  });
});
