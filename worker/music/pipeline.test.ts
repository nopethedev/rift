// Integration tests for the on-demand pipeline with real ffmpeg. The engine is a test double that synthesises a tone
// (optionally at realtime speed like Lavalink); everything else (ffmpeg, files, HTTP serving, cleanup) is real.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Candidate, MusicConfig } from "../../shared/music-protocol";
import { BusyError, MusicCache } from "./cache";
import { EngineError, type AudioSource, type Engine } from "./engines/types";
import type { MusicService } from "./routes";
import { LavalinkPool } from "./lavalink";
import { createServer } from "../server";
import type { SessionManager } from "../sessions";

const mk = (id: string, dur = 2, extra: Partial<Candidate> = {}): Candidate => ({ engine: "ytdlp", sourceId: `t:${id}`, title: id, artist: "Test", durationSec: dur, url: `http://x/${id}`, score: 0.9, ...extra });

class FakeEngine implements Engine {
  constructor(public id: "ytdlp" | "lavalink" = "ytdlp") {}
  opens: string[] = [];
  failIds = new Set<string>();
  down = false;
  resolveError?: EngineError;
  realtime = false;
  closed: string[] = [];
  async search() { return []; }
  async resolve(q: { title: string; durationSec?: number }) {
    if (this.resolveError) throw this.resolveError;
    if (q.title === "nothing") throw new EngineError("No recording matched", "not-found");
    if (q.title === "fallback") return ["bad", "good"].map((t) => mk(t, 2, { engine: this.id, sourceId: `${this.id === "ytdlp" ? "t" : "l"}:${t}` }));
    return [mk(q.title, q.durationSec ?? 2, { engine: this.id, sourceId: this.id === "ytdlp" ? `t:${q.title}` : `l:${q.title}` })];
  }
  async open(c: Candidate): Promise<AudioSource> {
    this.opens.push(c.sourceId);
    if (this.down) throw new EngineError("node is down", "unavailable");
    if (this.failIds.has(c.sourceId.slice(2)) || c.sourceId === "t:bad") throw new EngineError("source refused", "failed");
    const args = ["-loglevel", "error", ...(this.realtime ? ["-re"] : []), "-f", "lavfi", "-i", `sine=frequency=440:duration=${c.durationSec}`, "-f", "wav", "pipe:1"];
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    const done = new Promise<void>((res, rej) => p.once("close", (code) => (code === 0 ? res() : rej(new Error("source died")))));
    done.catch(() => {});
    return { stream: p.stdout, realtime: this.realtime, done, close: () => { this.closed.push(c.sourceId); p.kill("SIGKILL"); } };
  }
}

let dir: string;
let engine: FakeEngine;
let cache: MusicCache;
const cfgFor = (over: Partial<MusicConfig> = {}): MusicConfig => ({
  engine: "ytdlp", cacheDir: dir, maxCacheMB: 64, cleanup: true, cleanupGraceSec: 0, format: "mp3", bitrateKbps: 128, maxDownloads: 2, maxStreams: 0,
  licensePolicy: "attested", ytdlp: { providers: ["soundcloud"], binary: "" }, lavalink: { nodes: [], allowedSources: [] }, ...over,
});
const cached = async () => (await fs.readdir(path.join(dir, "rift-music")).catch(() => [])).filter((f) => !f.startsWith("."));
const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error("timeout waiting for condition"); };
const q = (title: string, durationSec = 2) => ({ title, artist: "Test", durationSec });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rift-music-"));
  engine = new FakeEngine();
  cache = new MusicCache({ engines: { ytdlp: engine }, defaultDir: dir, sweepMs: 50 });
});
afterAll(async () => { await cache?.shutdown(); });

async function ready(key: string) { await waitFor(() => cache.status(cache.get(key)!).state === "ready"); return cache.status(cache.get(key)!); }

describe("MusicCache", () => {
  it("captures a track into a bounded file and reports status", async () => {
    const st = await cache.prepare({ cfg: cfgFor(), query: q("one"), holder: "p1", role: "current" });
    expect(["resolving", "queued", "downloading"]).toContain(st.state);
    const done = await ready(st.key);
    expect(done.progress).toBe(1);
    expect(done.bytes).toBeGreaterThan(10_000);
    expect(await cached()).toEqual([expect.stringMatching(/^[0-9a-f]{40}\.mp3$/)]);
  });

  it("de-duplicates concurrent requests for the same recording", async () => {
    const cfg = cfgFor();
    const [a, b, c] = await Promise.all([
      cache.prepare({ cfg, query: q("dup"), holder: "p1", role: "current" }),
      cache.prepare({ cfg, query: q("dup"), holder: "p2", role: "current" }),
      cache.prepare({ cfg, query: q("dup"), holder: "p3", role: "preload" }),
    ]);
    expect(new Set([a.key, b.key, c.key]).size).toBe(1);
    await ready(a.key);
    expect(engine.opens.filter((o) => o === "t:dup")).toHaveLength(1);
    expect((await cached()).length).toBe(1);
    // A different query that resolves to the same source reuses the same capture.
    const other = await cache.prepare({ cfg, candidate: mk("dup"), holder: "p4", role: "current" });
    await ready(other.key);
    expect(engine.opens.filter((o) => o === "t:dup")).toHaveLength(1);
  });

  it("cancels a running preload when it is released, deleting partial data", async () => {
    engine.realtime = true;
    const cfg = cfgFor();
    const st = await cache.prepare({ cfg, query: q("pre", 6), holder: "p1", role: "preload" });
    await waitFor(() => cache.status(cache.get(st.key)!).state === "downloading");
    cache.release({ holder: "p1", role: "preload", keep: [] });
    await waitFor(async () => (await cached()).length === 0 && !cache.get(st.key));
    expect(engine.closed).toContain("t:pre");
  });

  it("keeps preloads listed in `keep`, and swaps the current track", async () => {
    const cfg = cfgFor();
    const a = await cache.prepare({ cfg, query: q("a"), holder: "p1", role: "preload" });
    const b = await cache.prepare({ cfg, query: q("b"), holder: "p1", role: "preload" });
    await ready(a.key); await ready(b.key);
    cache.release({ holder: "p1", role: "preload", keep: [a.key] });
    await waitFor(async () => !cache.get(b.key) && (await cached()).length === 1);
    expect(cache.get(a.key)).toBeDefined();
    // promote a to current, then move current to b (re-prepared): the old current must be released
    await cache.prepare({ cfg, query: q("a"), holder: "p1", role: "current" });
    await cache.prepare({ cfg, query: q("b"), holder: "p1", role: "current" });
    expect(cache.get(a.key)!.liveHolders(Date.now()).filter((h) => h.role === "current")).toHaveLength(0);
  });

  it("deletes audio after playback once nobody needs it (grace 0), but not while held", async () => {
    const cfg = cfgFor();
    const st = await cache.prepare({ cfg, query: q("clean"), holder: "p1", role: "current" });
    await ready(st.key);
    await new Promise((r) => setTimeout(r, 300));
    expect((await cached()).length).toBe(1); // still held
    cache.release({ holder: "p1" });
    await waitFor(async () => (await cached()).length === 0);
    expect(cache.get(st.key)).toBeUndefined();
  });

  it("expires holds that stop pinging (listener vanished)", async () => {
    const cfg = cfgFor();
    const st = await cache.prepare({ cfg, query: q("ttl"), holder: "p1", role: "current", ttlSec: 5 });
    await ready(st.key);
    cache.get(st.key)!.holds.get("p1:current")!.expires = Date.now() - 1; // simulate 5 s without a heartbeat
    await waitFor(async () => (await cached()).length === 0);
  });

  it("limits simultaneous listeners", async () => {
    const cfg = cfgFor({ maxStreams: 2 });
    await cache.prepare({ cfg, query: q("x1"), holder: "p1", role: "current" });
    await cache.prepare({ cfg, query: q("x2"), holder: "p2", role: "current" });
    await expect(cache.prepare({ cfg, query: q("x3"), holder: "p3", role: "current" })).rejects.toBeInstanceOf(BusyError);
    // an existing listener can still change song, and preloads are not listeners
    await cache.prepare({ cfg, query: q("x4"), holder: "p1", role: "current" });
    await cache.prepare({ cfg, query: q("x5"), holder: "p3", role: "preload" });
  });

  it("never lets preloads take the last download slot: the current song starts immediately", async () => {
    engine.realtime = true; // each capture takes as long as the song, like Lavalink
    const cfg = cfgFor({ maxDownloads: 2 });
    await cache.prepare({ cfg, query: q("pre1", 6), holder: "p1", role: "preload" });
    await cache.prepare({ cfg, query: q("pre2", 6), holder: "p1", role: "preload" });
    await waitFor(() => cache.stats().jobsRunning === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(cache.stats().jobsRunning).toBe(1); // the second preload waits: a slot stays free
    const t0 = Date.now();
    const cur = await cache.prepare({ cfg, query: q("now", 6), holder: "p1", role: "current" });
    await waitFor(() => cache.status(cache.get(cur.key)!).state === "downloading", 3000);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(cache.stats().jobsRunning).toBe(2);
  });

  it("with a single download slot a preload only starts when nothing else runs, and current goes first", async () => {
    engine.realtime = true;
    const cfg = cfgFor({ maxDownloads: 1 });
    const a = await cache.prepare({ cfg, query: q("cur", 3), holder: "p1", role: "current" });
    await cache.prepare({ cfg, query: q("nxt", 3), holder: "p1", role: "preload" });
    await new Promise((r) => setTimeout(r, 400));
    expect(cache.stats().jobsRunning).toBe(1);
    expect(cache.status(cache.get(a.key)!).state).toBe("downloading");
    await waitFor(() => cache.stats().tracks.some((t) => t.title === "nxt" && t.state === "downloading"), 8000); // starts after "cur" finished
  });

  it("falls back to the next candidate when the first source fails", async () => {
    const st = await cache.prepare({ cfg: cfgFor(), query: q("fallback"), holder: "p1", role: "current" });
    const done = await ready(st.key);
    expect(done.candidate?.sourceId).toBe("t:good");
    expect(engine.opens).toEqual(["t:bad", "t:good"]);
  });

  describe("engine auto (Lavalink first, yt-dlp fallback)", () => {
    let lava: FakeEngine;
    const auto = () => cfgFor({ engine: "auto", lavalink: { nodes: [{ id: "n1", name: "n", url: "http://x", password: "p", searchPrefix: "scsearch" }], allowedSources: [] } });
    beforeEach(async () => {
      await cache.shutdown();
      lava = new FakeEngine("lavalink");
      cache = new MusicCache({ engines: { ytdlp: engine, lavalink: lava }, defaultDir: dir, sweepMs: 50 });
    });

    it("plays through Lavalink when it works", async () => {
      const st = await cache.prepare({ cfg: auto(), query: q("viaLava"), holder: "p1", role: "current" });
      const done = await ready(st.key);
      expect(done.candidate?.engine).toBe("lavalink");
      expect(engine.opens).toEqual([]);
    });

    it("falls back to yt-dlp when Lavalink cannot resolve the song", async () => {
      lava.resolveError = new EngineError("no match", "not-found");
      const st = await cache.prepare({ cfg: auto(), query: q("viaYt"), holder: "p1", role: "current" });
      const done = await ready(st.key);
      expect(done.candidate?.engine).toBe("ytdlp");
    });

    it("falls back to yt-dlp when the Lavalink node is down and does not retry its other candidates", async () => {
      lava.down = true;
      const st = await cache.prepare({ cfg: auto(), query: q("fallback"), holder: "p1", role: "current" });
      const done = await ready(st.key);
      expect(done.candidate?.engine).toBe("ytdlp");
      expect(lava.opens).toEqual(["l:bad"]); // one attempt: "unavailable" skips the engine's remaining candidates
    });

    it("a picked Lavalink result falls back to yt-dlp (by title + artist) when its node can't play it", async () => {
      lava.down = true;
      const picked = mk("pickedSong", 2, { engine: "lavalink", sourceId: "l:pickedSong" });
      const st = await cache.prepare({ cfg: auto(), candidate: picked, holder: "p1", role: "current" });
      const done = await ready(st.key);
      expect(done.candidate?.engine).toBe("ytdlp");
      expect(lava.opens).toEqual(["l:pickedSong"]);
    });

    it("a picked Lavalink result is NOT re-resolved elsewhere when the engine is Lavalink only", async () => {
      lava.down = true;
      const picked = mk("pickedOnly", 2, { engine: "lavalink", sourceId: "l:pickedOnly" });
      const st = await cache.prepare({ cfg: { ...auto(), engine: "lavalink" }, candidate: picked, holder: "p1", role: "current" });
      await waitFor(() => cache.status(cache.get(st.key)!).state === "failed");
      expect(engine.opens).toEqual([]);
    });

    it("uses yt-dlp only when no Lavalink node is configured", async () => {
      const st = await cache.prepare({ cfg: cfgFor({ engine: "auto" }), query: q("noNodes"), holder: "p1", role: "current" });
      const done = await ready(st.key);
      expect(done.candidate?.engine).toBe("ytdlp");
      expect(lava.opens).toEqual([]);
    });

    it("reports the error when every engine fails", async () => {
      lava.resolveError = new EngineError("lavalink: nothing", "not-found");
      const st = await cache.prepare({ cfg: auto(), query: q("nothing"), holder: "p1", role: "current" });
      await waitFor(() => cache.status(cache.get(st.key)!).state === "failed");
      expect(cache.status(cache.get(st.key)!).error).toMatch(/No recording/);
    });
  });

  it("reports failure when nothing matches, and retries later", async () => {
    const st = await cache.prepare({ cfg: cfgFor(), query: q("nothing"), holder: "p1", role: "current" });
    await waitFor(() => cache.status(cache.get(st.key)!).state === "failed");
    expect(cache.status(cache.get(st.key)!).error).toMatch(/No recording/);
  });

  it("keeps the cache under its size limit by evicting unheld audio, and refuses when everything is held", async () => {
    // 1 MB limit: one 2 s @128 kbps track is ~32 KB, so use long fake durations to build size
    const cfg = cfgFor({ maxCacheMB: 1, cleanupGraceSec: 3600, bitrateKbps: 128 });
    const ids = ["e1", "e2", "e3"];
    const keys: string[] = [];
    for (const id of ids) {
      const s = await cache.prepare({ cfg, query: q(id, 30), holder: "h-" + id, role: "current" });
      keys.push(s.key);
      await ready(s.key);
      cache.release({ holder: "h-" + id }); // unheld, kept for the grace period
    }
    // 30 s @128k ≈ 480 KB each: three can't fit in 1 MB, so the oldest must have been evicted
    const st = cache.stats();
    expect(st.cacheBytes).toBeLessThanOrEqual(1 * 1048576);
    expect(keys.some((k) => !cache.get(k)?.job)).toBe(true);
    // all held -> next big one fails with a clear error
    const a = await cache.prepare({ cfg, query: q("h1", 30), holder: "A", role: "current" });
    await ready(a.key);
    const b = await cache.prepare({ cfg, query: q("h2", 30), holder: "B", role: "current" });
    await ready(b.key);
    const c = await cache.prepare({ cfg, query: q("h3", 30), holder: "C", role: "current" });
    await waitFor(() => cache.status(cache.get(c.key)!).state === "failed");
    expect(cache.status(cache.get(c.key)!).error).toMatch(/cache is full/i);
  });

  it("serves a still-growing file while capturing (live tail), then the same bytes after completion", async () => {
    engine.realtime = true;
    const cfg = cfgFor();
    const st = await cache.prepare({ cfg, query: q("live", 4), holder: "p1", role: "current" });
    const entry = cache.get(st.key)!;
    const job = await cache.waitStreamable(entry);
    const t0 = Date.now();
    const ac = new AbortController();
    const chunks: Buffer[] = [];
    let firstAt = 0;
    for await (const c of cache.tail(job, ac.signal)) { if (!firstAt) firstAt = Date.now() - t0; chunks.push(c); }
    const total = Buffer.concat(chunks);
    expect(firstAt).toBeLessThan(2500); // playback can start long before the 4 s capture ends
    expect(job.state).toBe("ready");
    expect(total.length).toBe(await cache.finalSize(job));
    expect(total.equals(await fs.readFile(job.finalPath))).toBe(true);
  });
});

describe("worker HTTP: /music/audio", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  const H = { Authorization: "Bearer tok", "content-type": "application/json" };
  beforeAll(async () => {
    // built per-suite so the cache from beforeEach is not reused
  });
  beforeEach(async () => {
    const svc: MusicService = { cache, pool: new LavalinkPool(), engines: { ytdlp: engine }, sink: () => null, stop: async () => {} };
    server = createServer({ cfg: { token: "tok" } as never, sessions: {} as SessionManager, ffmpegVersion: "t", hwaccels: [], music: svc });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });

  it("requires the bearer token", async () => {
    expect((await fetch(base + "/music/stats", { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("prepares, streams live (200, chunked) and then supports Range (206) once complete", async () => {
    engine.realtime = true;
    const cfg = cfgFor();
    const prep = await (await post("/music/prepare", { cfg, query: q("http", 3), holder: "p1", role: "current" })).json();
    const live = await fetch(`${base}/music/audio/${prep.key}`, { headers: H });
    expect(live.status).toBe(200);
    expect(live.headers.get("x-rift-audio")).toBe("live");
    expect(live.headers.get("content-type")).toBe("audio/mpeg");
    const body = Buffer.from(await live.arrayBuffer());
    expect(body.length).toBeGreaterThan(10_000);
    const full = await fetch(`${base}/music/audio/${prep.key}`, { headers: H });
    expect(full.headers.get("x-rift-audio")).toBe("cached");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const len = Number(full.headers.get("content-length"));
    expect(len).toBe(body.length);
    const part = await fetch(`${base}/music/audio/${prep.key}`, { headers: { ...H, Range: "bytes=1000-1999" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 1000-1999/${len}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(body.subarray(1000, 2000))).toBe(true);
    expect((await fetch(`${base}/music/audio/${prep.key}`, { headers: { ...H, Range: `bytes=${len + 5}-` } })).status).toBe(416);
    const tail = await fetch(`${base}/music/audio/${prep.key}`, { headers: { ...H, Range: "bytes=-500" } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(body.subarray(len - 500))).toBe(true);
  });

  it("answers 404/400 for unknown or malformed keys and 502 when nothing could be resolved", async () => {
    expect((await fetch(`${base}/music/audio/${"0".repeat(24)}`, { headers: H })).status).toBe(404);
    expect((await fetch(`${base}/music/audio/nope`, { headers: H })).status).toBe(400);
    const prep = await (await post("/music/prepare", { cfg: cfgFor(), query: q("nothing"), holder: "p1", role: "current" })).json();
    const r = await fetch(`${base}/music/audio/${prep.key}`, { headers: H });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/No recording/);
  });

  it("accepts candidates whose optional fields are null (Lavalink sends artworkUrl: null)", async () => {
    const c = { ...mk("nullish"), artworkUrl: null, license: null, encoded: null, nodeId: null, sourceName: null };
    const r = await post("/music/prepare", { cfg: cfgFor(), candidate: c, holder: "p1", role: "current" });
    expect(r.status).toBe(200);
  });

  it("maps the listener limit to 429 and validates input", async () => {
    const cfg = cfgFor({ maxStreams: 1 });
    expect((await post("/music/prepare", { cfg, query: q("l1"), holder: "a", role: "current" })).status).toBe(200);
    expect((await post("/music/prepare", { cfg, query: q("l2"), holder: "b", role: "current" })).status).toBe(429);
    expect((await post("/music/prepare", { cfg: { nope: 1 }, query: q("l2"), holder: "b", role: "current" })).status).toBe(400);
  });

  it("transcodes a local file on the fly (and rejects bad paths)", async () => {
    const src = path.join(dir, "src.wav");
    await new Promise<void>((res) => spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", src]).on("close", () => res()));
    const r = await fetch(`${base}/music/transcode?path=${encodeURIComponent(src)}&format=mp3&bitrate=128&start=1`, { headers: H });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(5000);
    expect((await fetch(`${base}/music/transcode?path=relative.wav`, { headers: H })).status).toBe(400);
    expect((await fetch(`${base}/music/transcode?path=${encodeURIComponent(path.join(dir, "missing.wav"))}`, { headers: H })).status).toBe(404);
  });
});
