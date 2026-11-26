import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Candidate, MusicConfig } from "../../../shared/music-protocol";
import type { LavalinkPool } from "../lavalink";
import { parseBandcampPage } from "./bandcamp";
import { findClientId, pickTranscoding } from "./soundcloud";
import { CHUNK_BYTES, openDirect, parsePlaylist } from "./stream";
import { youtubeId } from "./youtube";

const collect = async (s: NodeJS.ReadableStream) => { const parts: Buffer[] = []; for await (const c of s) parts.push(c as Buffer); return Buffer.concat(parts); };

// A fake CDN: /file honours `?range=a-b` like Google's, /seg/N are HLS segments, /broken fails half-way.
const file = Buffer.alloc(Math.round(CHUNK_BYTES * 2.5));
for (let i = 0; i < file.length; i++) file[i] = (i * 31) & 255;
const requests: string[] = [];
let base = "";
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  requests.push(u.pathname + u.search);
  if (u.pathname === "/file") {
    const [a, b] = (u.searchParams.get("range") ?? `0-${file.length - 1}`).split("-").map(Number);
    res.writeHead(200, { "content-type": "audio/mp4" });
    res.end(file.subarray(a, Math.min(b, file.length - 1) + 1));
  } else if (u.pathname === "/list.m3u8") {
    res.end("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg/0\n#EXTINF:10,\nseg/1\n#EXTINF:4,\nseg/2\n#EXT-X-ENDLIST\n");
  } else if (u.pathname.startsWith("/seg/")) {
    res.end(Buffer.from(`segment-${u.pathname.slice(5)};`));
  } else if (u.pathname === "/gone") {
    res.writeHead(403); res.end();
  } else { res.writeHead(404); res.end(); }
});
beforeAll(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => { server.close(); });

describe("direct download", () => {
  it("fetches a CDN file in ranges and streams it whole", async () => {
    requests.length = 0;
    const src = openDirect({ url: `${base}/file?id=1`, headers: {}, mime: "audio/mp4", contentLength: file.length, durationSec: 1, expiresAt: Date.now() + 1e6, chunked: true, via: "test" });
    const got = await collect(src.stream);
    await src.done;
    expect(src.realtime).toBe(false);
    expect(got.equals(file)).toBe(true);
    expect(requests).toEqual([`/file?id=1&range=0-${CHUNK_BYTES - 1}`, `/file?id=1&range=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}`, `/file?id=1&range=${2 * CHUNK_BYTES}-${file.length - 1}`]);
  });

  it("joins HLS segments in order", async () => {
    const src = openDirect({ url: `${base}/list.m3u8`, headers: {}, mime: "audio/mpeg", durationSec: 24, expiresAt: Date.now() + 1e6, hls: true, via: "test" });
    expect((await collect(src.stream)).toString()).toBe("segment-0;segment-1;segment-2;");
    await src.done;
  });

  it("reports a refused URL as not-found", async () => {
    const src = openDirect({ url: `${base}/gone`, headers: {}, mime: "audio/mpeg", durationSec: 1, expiresAt: 0, via: "test" });
    src.stream.on("error", () => {});
    await expect(src.done).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses encrypted HLS", () => {
    expect(() => parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\nseg.ts", "https://x/")).toThrow(/Encrypted/);
    expect(parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\na.mp3\n", "https://x/p/list.m3u8")).toEqual(["https://x/p/a.mp3"]);
  });
});

describe("extractor parsers", () => {
  it("recognises YouTube links", () => {
    expect(youtubeId("https://music.youtube.com/watch?v=lYBUbBu4W08&si=x")).toBe("lYBUbBu4W08");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://soundcloud.com/a/b")).toBeNull();
  });

  it("picks SoundCloud's full-length progressive MP3 over HLS, Opus and previews", () => {
    const tc = (protocol: string, mime: string, snipped = false) => ({ url: `${protocol}/${mime}`, snipped, format: { protocol, mime_type: mime } });
    expect(pickTranscoding({ id: 1, media: { transcodings: [tc("hls", "audio/ogg; codecs=\"opus\""), tc("hls", "audio/mpeg"), tc("progressive", "audio/mpeg", true)] } })?.url).toBe("hls/audio/mpeg");
    expect(pickTranscoding({ id: 1, media: { transcodings: [tc("hls", "audio/mpeg"), tc("progressive", "audio/mpeg")] } })?.url).toBe("progressive/audio/mpeg");
    expect(pickTranscoding({ id: 1, media: { transcodings: [tc("encrypted-hls", "audio/mp4"), tc("hls", "audio/mpeg", true)] } })).toBeUndefined();
    expect(findClientId('a,client_id:"AbCdEfGhIjKlMnOpQrStUvWxYz012345",b')).toBe("AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  });

  it("reads Bandcamp's MP3 stream from the page", () => {
    const data = JSON.stringify({ trackinfo: [{ file: { "mp3-128": "https://t4.bcbits.com/stream/x" }, duration: 201.5 }] }).replace(/"/g, "&quot;");
    expect(parseBandcampPage(`<div data-tralbum="${data}"></div>`)).toEqual({ url: "https://t4.bcbits.com/stream/x", durationSec: 201.5 });
    expect(() => parseBandcampPage(`<div data-tralbum="${JSON.stringify({ trackinfo: [{ file: null }] }).replace(/"/g, "&quot;")}"></div>`)).toThrow(/purchase/);
  });
});

describe("lavalink engine plays through the CDN extractor", () => {
  const cfg = { engine: "lavalink", licensePolicy: "attested", lavalink: { nodes: [], allowedSources: ["youtube", "soundcloud", "spotify", "http"] } } as unknown as MusicConfig;
  const pool = { sync() {}, ordered: () => [{ cfg: { id: "n1" }, online: true }], get: () => undefined } as unknown as LavalinkPool;
  const cand = (sourceName: string): Candidate => ({ engine: "lavalink", sourceId: `lavalink:${sourceName}:x`, title: "Song", artist: "Artist", durationSec: 200, url: `https://${sourceName}.com/x`, score: 1, sourceName, encoded: "e" });

  it("uses the CDN (no voice sink needed), falls back to the sink, and explains when neither works", async () => {
    vi.resetModules();
    const extractBest = vi.fn(async (c: Candidate) => {
      if (c.sourceName === "soundcloud") throw Object.assign(new Error("SoundCloud answered 500"), { code: "failed" });
      return { url: `${base}/seg/9`, headers: {}, mime: "audio/mpeg", durationSec: 1, expiresAt: Date.now() + 1e6, via: "youtube/visionos" };
    });
    vi.doMock("../direct", async (orig) => ({ ...(await orig<typeof import("../direct")>()), extractBest }));
    const { lavalinkEngine } = await import("../engines/lavalink");
    const engine = lavalinkEngine(pool, () => null);

    const yt = await engine.open(cand("youtube"), cfg);
    expect((await collect(yt.stream)).toString()).toBe("segment-9;");
    expect(yt.realtime).toBe(false);
    // Spotify tracks go through the extractor too (it plays their YouTube match).
    await engine.open(cand("spotify"), cfg).then((s) => s.close());
    expect(extractBest).toHaveBeenCalledTimes(2);
    // Extractor fails and there's no voice sink: the extractor's reason is reported.
    await expect(engine.open(cand("soundcloud"), cfg)).rejects.toThrow(/SoundCloud answered 500/);
    // Plain HTTP links have no extractor: the sink is required, as before.
    await expect(engine.open({ ...cand("http"), sourceName: "http" }, cfg)).rejects.toThrow(/voice sink/);
    vi.doUnmock("../direct");
  });
});

/** Opt-in network check: LIVE_DIRECT=1 npx vitest run worker/music/direct */
describe.runIf(process.env.LIVE_DIRECT === "1")("live extractor", () => {
  it("gets a YouTube CDN URL and finds a playable upload for a Topic song", async () => {
    const { extract, extractBest } = await import("./index");
    const a = await extract("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube");
    console.log("youtube:", a.via, a.mime, a.contentLength, new URL(a.url).host);
    expect(a.url).toMatch(/^https:\/\/.+googlevideo\.com\//);
    const b = await extractBest({ url: "https://music.youtube.com/watch?v=lYBUbBu4W08", sourceName: "youtube", title: "Never Gonna Give You Up", artist: "Rick Astley", durationSec: 213 });
    console.log("topic song:", b.via, new URL(b.url).host);
    const s = await extractBest({ url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", sourceName: "spotify", title: "Never Gonna Give You Up", artist: "Rick Astley", durationSec: 213 });
    console.log("spotify mirror:", s.via);
  }, 60_000);
});
