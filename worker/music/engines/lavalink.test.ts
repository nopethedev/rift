import { describe, expect, it } from "vitest";
import type { MusicConfig } from "../../../shared/music-protocol";
import type { LavalinkPool, LavalinkTrack } from "../lavalink";
import type { VoiceSink } from "../voice-sink";
import { lavalinkEngine } from "./lavalink";

const track = (source: string, id: string, title: string): LavalinkTrack => ({
  encoded: `${source}:${id}`,
  info: { identifier: id, title, author: `${source} artist`, length: 200_000, isStream: false, uri: `https://${source}.example/${id}`, sourceName: source, artworkUrl: null },
} as unknown as LavalinkTrack);

/** A fake node that answers each search prefix with that prefix's own tracks. */
function fake(prefixes: Record<string, LavalinkTrack[] | Error>, searchPrefix: string) {
  const calls: string[] = [];
  const node = {
    cfg: { id: "n1", name: "fake", url: "http://x", password: "x", searchPrefix },
    waitReady: async () => "sid",
    search: async (prefix: string) => { calls.push(prefix); const r = prefixes[prefix] ?? []; if (r instanceof Error) throw r; return r; },
    load: async () => ({ loadType: "empty", data: {} }),
  };
  const pool = { sync() {}, ordered: () => [node] } as unknown as LavalinkPool;
  return { engine: lavalinkEngine(pool, () => ({}) as VoiceSink), calls };
}

const cfg = (allowed: string[]): MusicConfig => ({
  engine: "lavalink", cacheDir: "", maxCacheMB: 1, cleanup: true, cleanupGraceSec: 0, format: "mp3", bitrateKbps: 128, maxDownloads: 1, maxStreams: 0,
  licensePolicy: "attested", ytdlp: { providers: [], binary: "" }, lavalink: { nodes: [], allowedSources: allowed },
});

const data = {
  scsearch: [track("soundcloud", "a", "SC One"), track("soundcloud", "b", "SC Two")],
  ytsearch: [track("youtube", "c", "YT One"), track("youtube", "d", "YT Two")],
};

describe("lavalink engine: several search prefixes per node", () => {
  it("searches every listed prefix and interleaves the answers", async () => {
    const { engine, calls } = fake(data, "scsearch,ytsearch");
    const found = await engine.search("song", cfg(["soundcloud", "youtube"]), 10);
    expect(calls.sort()).toEqual(["scsearch", "ytsearch"]);
    expect(found.map((c) => c.sourceName)).toEqual(["soundcloud", "youtube", "soundcloud", "youtube"]);
  });

  it("'auto' searches the allowed sources' prefixes (YouTube = YouTube Music + YouTube)", async () => {
    const { engine, calls } = fake(data, "auto");
    const found = await engine.search("song", cfg(["soundcloud", "youtube", "http"]), 10);
    expect(calls.sort()).toEqual(["scsearch", "ytmsearch", "ytsearch"]);
    expect(new Set(found.map((c) => c.sourceName))).toEqual(new Set(["soundcloud", "youtube"]));
  });

  it("a single prefix still only searches that source", async () => {
    const { engine, calls } = fake(data, "scsearch");
    const found = await engine.search("song", cfg(["soundcloud", "youtube"]), 10);
    expect(calls).toEqual(["scsearch"]);
    expect(found.every((c) => c.sourceName === "soundcloud")).toBe(true);
  });

  it("one prefix failing doesn't hide the other's results", async () => {
    const { engine } = fake({ scsearch: new Error("soundcloud blocked"), ytsearch: data.ytsearch }, "scsearch,ytsearch");
    const found = await engine.search("song", cfg(["soundcloud", "youtube"]), 10);
    expect(found.map((c) => c.title)).toEqual(["YT One", "YT Two"]);
  });

  it("errors only when every prefix fails", async () => {
    const { engine } = fake({ scsearch: new Error("sc down"), ytsearch: new Error("yt down") }, "scsearch,ytsearch");
    await expect(engine.search("song", cfg(["soundcloud", "youtube"]), 10)).rejects.toThrow(/sc down/);
  });

  it("still drops sources that aren't allowed", async () => {
    const { engine } = fake(data, "scsearch,ytsearch");
    const found = await engine.search("song", cfg(["soundcloud"]), 10);
    expect(found.every((c) => c.sourceName === "soundcloud")).toBe(true);
  });
});

describe("explainTrackError", () => {
  it("turns YouTube's refusals into what to change", async () => {
    const { explainTrackError } = await import("./lavalink");
    expect(explainTrackError("Sign in to confirm you're not a bot", "youtube")).toMatch(/sign-in|poToken/);
    expect(explainTrackError("Must find sig function from script", "youtube")).toMatch(/remote cipher/);
    expect(explainTrackError("All clients failed to load the item", "youtube")).toMatch(/clients/);
    expect(explainTrackError("Something broke", "soundcloud")).toBe("Lavalink: Something broke");
  });
});

describe("lavalink engine: playback events", () => {
  it("a TrackStuckEvent is only a warning: the song keeps going and ends normally", async () => {
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");
    const node = Object.assign(new EventEmitter(), { cfg: { id: "n1", name: "fake" }, online: true, play: async () => {}, destroy: async () => {} });
    const pool = { sync() {}, ordered: () => [node], get: () => node } as unknown as LavalinkPool;
    const ticket = { guildId: "g1", voice: {}, connected: Promise.resolve(), stream: new PassThrough(), close() {} };
    const engine = lavalinkEngine(pool, () => ({ createTicket: () => ticket }) as unknown as VoiceSink);
    const src = await engine.open({ engine: "lavalink", sourceId: "x", title: "t", artist: "a", durationSec: 1, url: "", score: 1, encoded: "e", nodeId: "n1", sourceName: "youtube" }, cfg(["youtube"]));
    let settled: string | null = null;
    src.done.then(() => (settled = "ok"), (e: Error) => (settled = e.message));
    node.emit("event", { type: "TrackStuckEvent", guildId: "g1", thresholdMs: 10000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBeNull();
    node.emit("event", { type: "TrackEndEvent", guildId: "g1", reason: "finished" });
    await new Promise((r) => setTimeout(r, 500));
    expect(settled).toBe("ok");
  });
});
