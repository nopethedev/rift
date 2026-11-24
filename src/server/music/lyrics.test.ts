import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = { musicLyrics: true, musicLavalinkAllowedSources: ["soundcloud"], musicLavalinkNodes: [{ id: "a", name: "A", url: "http://ll.test", password: "pw", searchPrefix: "scsearch" }] };
vi.mock("../settings", () => ({ getSettings: async () => settings }));
const { clearLyricsCache, findLyrics, mapLyrics } = await import("./lyrics");

const track = (title: string, author: string, sec: number, encoded = `enc-${title}`) => ({ encoded, info: { title, author, length: sec * 1000, isStream: false, sourceName: "youtube" } });
let handler: (url: URL) => Response;
const calls: string[] = [];
beforeEach(() => {
  clearLyricsCache();
  calls.length = 0;
  settings.musicLyrics = true;
  vi.stubGlobal("fetch", async (u: string | URL, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe("pw");
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    return handler(url);
  });
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("mapLyrics", () => {
  it("keeps synced lines sorted, falls back to plain text", () => {
    expect(mapLyrics({ provider: "LRCLIB", lines: [{ timestamp: 2000, line: "b" }, { timestamp: 1000, duration: 900, line: "a " }] })).toEqual({ provider: "LRCLIB", source: null, synced: true, lines: [{ t: 1000, d: 900, text: "a" }, { t: 2000, d: null, text: "b" }], text: "b\na" });
    expect(mapLyrics({ text: "la la\nla", lines: [] })).toMatchObject({ synced: false, lines: [], text: "la la\nla" });
    expect(mapLyrics({ text: "", lines: [] })).toBeNull();
  });
});

describe("findLyrics", () => {
  it("searches YouTube Music for the song, picks the matching result and asks LavaLyrics", async () => {
    handler = (url) => {
      const id = url.searchParams.get("identifier");
      if (url.pathname === "/v4/loadtracks") return id?.startsWith("ytmsearch:") ? json({ loadType: "search", data: [track("Totally Different Song", "Nobody", 100), track("Get Lucky", "Daft Punk", 248)] }) : json({ loadType: "empty", data: {} });
      if (url.pathname === "/v4/lyrics") return url.searchParams.get("track") === "enc-Get Lucky" ? json({ sourceName: "lrclib", provider: "LRCLIB", text: null, lines: [{ timestamp: 0, line: "Like the legend" }, { timestamp: 4200, line: "of the phoenix" }] }) : new Response(null, { status: 204 });
      return new Response("", { status: 404 });
    };
    const r = await findLyrics({ title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk", durationSec: 248 });
    expect(r.lyrics?.synced).toBe(true);
    expect(r.lyrics?.lines[1]).toEqual({ t: 4200, d: null, text: "of the phoenix" });
    expect(calls[0]).toContain("ytmsearch%3ADaft%20Punk%20Get%20Lucky");
    // cached
    await findLyrics({ title: "Get Lucky (feat. Pharrell Williams)", artist: "Daft Punk", durationSec: 248 });
    expect(calls.filter((c) => c.startsWith("/v4/lyrics"))).toHaveLength(1);
  });

  it("explains a node without LavaLyrics, and doesn't call it again right away", async () => {
    handler = (url) => (url.pathname === "/v4/loadtracks" ? json({ loadType: "search", data: [track("Get Lucky", "Daft Punk", 248)] }) : new Response("", { status: 404 }));
    expect((await findLyrics({ title: "Get Lucky", artist: "Daft Punk" })).reason).toMatch(/LavaLyrics/);
    const n = calls.length;
    await findLyrics({ title: "One More Time", artist: "Daft Punk" });
    expect(calls.length).toBe(n);
  });

  it("no matching search result / no lyrics -> a plain 'not found'", async () => {
    handler = (url) => (url.pathname === "/v4/loadtracks" ? json({ loadType: "search", data: [track("Get Lucky", "Daft Punk", 248)] }) : new Response(null, { status: 204 }));
    expect(await findLyrics({ title: "Get Lucky", artist: "Daft Punk" })).toEqual({ lyrics: null, reason: "No lyrics found for this song." });
  });

  it("turned off / no node", async () => {
    settings.musicLyrics = false;
    expect((await findLyrics({ title: "x", artist: "y" })).reason).toMatch(/turned off/);
  });
});
