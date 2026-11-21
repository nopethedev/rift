import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const settings = {
  torrentSearchProviders: [] as string[],
  torznabUrl: "",
  torznabApiKey: "",
};
vi.mock("@/server/settings", () => ({ getSettings: async () => settings }));

const HASH = "c9e15763f722f23e98a29decdfae341b98d53056";
const TORRENT = Buffer.from(`d4:infod6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:${"p".repeat(20)}ee`);

const TORZNAB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel><title>Jackett</title>
<item>
  <title>Some.Movie.2019.1080p.BluRay.x264-GRP</title>
  <guid>https://tracker.example/details/1</guid>
  <link>__BASE__/dl/1</link>
  <comments>https://tracker.example/details/1</comments>
  <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
  <size>1610612736</size>
  <enclosure url="__BASE__/dl/1" length="1610612736" type="application/x-bittorrent" />
  <torznab:attr name="seeders" value="50" />
  <torznab:attr name="peers" value="60" />
  <torznab:attr name="infohash" value="${HASH.toUpperCase()}" />
</item>
<item>
  <title><![CDATA[Some Movie & Friends 2019 720p]]></title>
  <link>__BASE__/dl/2</link>
  <torznab:attr name="seeders" value="5"/>
  <torznab:attr name="peers" value="7"/>
  <torznab:attr name="size" value="734003200"/>
  <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${"d".repeat(40)}&amp;dn=x"/>
</item>
</channel></rss>`;

let server: http.Server;
let base = "";
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push(u.pathname + u.search);
    if (u.pathname === "/torznab/api") {
      if (u.searchParams.get("apikey") !== "k") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><error code="100" description="Invalid API Key" />`);
      }
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(TORZNAB_XML.replaceAll("__BASE__", base));
    }
    if (u.pathname === "/dl/1") {
      res.writeHead(302, { location: `magnet:?xt=urn:btih:${HASH}` });
      return res.end();
    }
    if (u.pathname === "/dl/2") {
      res.writeHead(200, { "content-type": "application/x-bittorrent" });
      return res.end(TORRENT);
    }
    if (u.pathname === "/advancedsearch.php") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ response: { docs: [{ identifier: "night_of_the_living_dead", title: "Night of the Living Dead", item_size: 1234567890, year: "1968", downloads: 100 }, { identifier: "../evil" }] } }));
    }
    if (u.pathname === "/download/night_of_the_living_dead/night_of_the_living_dead_archive.torrent") {
      res.writeHead(200);
      return res.end(TORRENT);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ARCHIVE_ORG_URL = base;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("search helpers", async () => {
  const s = await import("./search");

  it("buildSearchQuery", () => {
    expect(s.buildSearchQuery({ title: "Movie: Name!", year: 2019, mediaType: "movie" })).toBe("Movie Name 2019");
    expect(s.buildSearchQuery({ title: "Show Name", mediaType: "tv", season: 1, episode: 2 })).toBe("Show Name S01E02");
    expect(s.buildSearchQuery({ title: "Show Name", mediaType: "tv", season: 3 })).toBe("Show Name S03");
    expect(s.buildSearchQuery({ title: "Marvel's Agents of S.H.I.E.L.D.", mediaType: "tv" })).toBe("Marvels Agents of S H I E L D");
    expect(s.buildSearchQuery({ title: "Amélie", year: 2001, mediaType: "movie" })).toBe("Amelie 2001");
  });

  it("parseSize", () => {
    expect(s.parseSize("1.5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(s.parseSize("700 MiB")).toBe(700 * 1024 ** 2);
    expect(s.parseSize("1,234.5 KB")).toBe(Math.round(1234.5 * 1024));
    expect(s.parseSize("n/a")).toBeUndefined();
  });

  it("parseTorznab", () => {
    const items = s.parseTorznab(TORZNAB_XML.replaceAll("__BASE__", "http://h"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Some.Movie.2019.1080p.BluRay.x264-GRP", seeders: 50, peers: 60, size: 1610612736, infoHash: HASH, link: "http://h/dl/1" });
    expect(items[1]).toMatchObject({ title: "Some Movie & Friends 2019 720p", seeders: 5, size: 734003200, infoHash: "d".repeat(40) });
    expect(items[1].magnet).toContain("&dn=x");
    expect(() => s.parseTorznab(`<error code="100" description="Invalid API Key"/>`)).toThrow("Invalid API Key");
  });

  it("mergeResults dedupes and sorts by seeds", () => {
    const r = s.mergeResults([
      { id: "1", title: "A", provider: "x", seeds: 3, peers: 0, size: "1 GB", infoHash: HASH },
      { id: "2", title: "A copy", provider: "y", seeds: 9, peers: 0, size: "1 GB", infoHash: HASH },
      { id: "3", title: "B", provider: "y", seeds: 5, peers: 0, size: "2 GB", sizeBytes: 2e9 },
      { id: "4", title: "b", provider: "z", seeds: 1, peers: 0, size: "2 GB", sizeBytes: 2e9 },
    ]);
    expect(r.map((x) => x.id)).toEqual(["2", "3"]);
  });
});

describe("searchTorrentsDetailed", async () => {
  const s = await import("./search");

  it("merges archive + torznab and reports per-provider status; a broken provider does not break the search", async () => {
    settings.torznabUrl = `${base}/torznab/`;
    settings.torznabApiKey = "k";
    settings.torrentSearchProviders = ["DefinitelyNotAProvider"];
    const { results, providers } = await s.searchTorrentsDetailed("Some Movie", { category: "movies" });
    const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
    expect(byName["Internet Archive"]).toMatchObject({ ok: true, count: 1 });
    expect(byName.Torznab).toMatchObject({ ok: true, count: 2 });
    expect(byName.DefinitelyNotAProvider.ok).toBe(false);
    expect(results[0].seeds).toBe(50);
    expect(results[0].peers).toBe(10);
    expect(results.map((r) => r.provider)).toEqual(["Torznab", "Torznab", "Internet Archive"]);
    expect(seen.some((q) => q.includes("cat=2000") && q.includes("t=search"))).toBe(true);
    const ia = results.find((r) => r.provider === "Internet Archive")!;
    expect(ia.torrentUrl).toBe(`${base}/download/night_of_the_living_dead/night_of_the_living_dead_archive.torrent`);
    expect(JSON.parse(JSON.stringify(results))).toEqual(results);
  });

  it("reports a Torznab API error", async () => {
    settings.torznabApiKey = "wrong";
    const { providers } = await s.searchTorrentsDetailed("x");
    expect(providers.find((p) => p.name === "Torznab")).toMatchObject({ ok: false, error: "Invalid API Key" });
    settings.torznabApiKey = "k";
  });

  it("resolveTorrentSource", async () => {
    const { results } = await s.searchTorrentsDetailed("Some Movie");
    const first = results.find((r) => r.title.startsWith("Some.Movie"))!;
    // Jackett-style redirect to a magnet (strip the magnet we already have to force the download path)
    expect(await s.resolveTorrentSource({ ...first, magnet: undefined })).toEqual({ magnet: `magnet:?xt=urn:btih:${HASH}` });
    const ia = results.find((r) => r.provider === "Internet Archive")!;
    const src = await s.resolveTorrentSource(ia);
    expect(src.torrentFile?.equals(TORRENT)).toBe(true);
    // links to foreign hosts are refused for Torznab results
    await expect(s.resolveTorrentSource({ ...first, magnet: undefined, infoHash: undefined, raw: { provider: "Torznab", link: "http://evil.example/x" } })).rejects.toThrow(/does not belong/);
  });

  it("listSearchProviders", async () => {
    settings.torrentSearchProviders = ["1337x"];
    const list = await s.listSearchProviders();
    expect(list.find((p) => p.name === "Internet Archive")?.enabled).toBe(true);
    expect(list.find((p) => p.name === "1337x")).toMatchObject({ kind: "scraper", enabled: true });
    expect(list.find((p) => p.name === "ThePirateBay")?.enabled).toBe(false);
    expect(list.find((p) => p.name === "IpTorrents")?.requiresConfig).toBe(true);
  });

  it("empty query is rejected", async () => {
    await expect(s.searchTorrentsDetailed("  ")).rejects.toThrow(/empty/);
  });
});
