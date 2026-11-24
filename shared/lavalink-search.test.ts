import { describe, expect, it } from "vitest";
import { searchPrefixes, sourceAllowed } from "./lavalink-search";

describe("searchPrefixes", () => {
  it("defaults to scsearch", () => {
    expect(searchPrefixes("")).toEqual(["scsearch"]);
    expect(searchPrefixes(undefined)).toEqual(["scsearch"]);
    expect(searchPrefixes("   ")).toEqual(["scsearch"]);
  });
  it("keeps a single prefix", () => expect(searchPrefixes("ytsearch")).toEqual(["ytsearch"]));
  it("splits on commas, spaces and semicolons, lowercases and dedupes", () => {
    expect(searchPrefixes("ytsearch, SCSEARCH;spsearch  ytsearch")).toEqual(["ytsearch", "scsearch", "spsearch"]);
  });
  it("drops junk tokens", () => expect(searchPrefixes("scsearch, bad:prefix, x")).toEqual(["scsearch"]));
  it("auto derives prefixes from the allowed sources", () => {
    expect(searchPrefixes("auto", ["soundcloud", "bandcamp", "youtube", "http"])).toEqual(["scsearch", "bcsearch", "ytmsearch", "ytsearch"]);
  });
  it("auto with nothing mappable falls back to scsearch", () => expect(searchPrefixes("auto", ["http"])).toEqual(["scsearch"]));
  it("auto can be combined with explicit prefixes", () => {
    expect(searchPrefixes("auto, dzsearch", ["soundcloud"])).toEqual(["scsearch", "dzsearch"]);
  });
  it("caps the number of prefixes", () => expect(searchPrefixes("aa,bb,cc,dd,ee,ff,gg,hh")).toHaveLength(6));
});

describe("sourceAllowed", () => {
  it("matches names case-insensitively and treats youtube / youtubemusic as one", () => {
    expect(sourceAllowed(["SoundCloud"], "soundcloud")).toBe(true);
    expect(sourceAllowed(["soundcloud"], "youtube")).toBe(false);
    expect(sourceAllowed(["youtubemusic"], "youtube")).toBe(true);
    expect(sourceAllowed(["youtube"], "youtube")).toBe(true);
    expect(sourceAllowed([], undefined)).toBe(true);
  });
});
