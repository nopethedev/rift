// End-to-end tests with the REAL external tools (skipped when they are not available):
//   yt-dlp  -> needs `yt-dlp` on PATH (pulls from a local HTTP server through its generic extractor)
//   Lavalink -> needs LAVALINK_JAR (+ java): a real Lavalink node plays into the Rift voice sink
// Search against YouTube / SoundCloud needs internet and is not covered here.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate, MusicConfig } from "../../shared/music-protocol";
import { MusicCache } from "./cache";
import { lavalinkEngine } from "./engines/lavalink";
import { ytdlpEngine, ytdlpVersion } from "./engines/ytdlp";
import { LavalinkPool } from "./lavalink";
import { loadSinkEnv, startSink } from "./sink-tls";
import type { VoiceSink } from "./voice-sink";

const have = (cmd: string) => { try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
const JAR = process.env.LAVALINK_JAR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rift-e2e-"));
const tone = path.join(tmp, "tone.mp3");
let fileServer: http.Server;
let toneUrl = "";

const cfgFor = (over: Partial<MusicConfig> = {}): MusicConfig => ({
  engine: "ytdlp", cacheDir: path.join(tmp, "cache"), maxCacheMB: 64, cleanup: true, cleanupGraceSec: 0, format: "mp3", bitrateKbps: 128, maxDownloads: 2, maxStreams: 0,
  licensePolicy: "attested", ytdlp: { providers: ["soundcloud"], binary: "" }, lavalink: { nodes: [], allowedSources: ["http"] }, ...over,
});

/** Decodes audio and measures: seconds of tone and dominant frequency via zero crossings. */
function analyse(file: string): { seconds: number; hz: number } {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  let zc = 0, prev = 0, first = -1, last = 0;
  for (let i = 0; i < raw.length / 2; i++) {
    const v = raw.readInt16LE(i * 2);
    if (Math.abs(v) > 1000) { if (first < 0) first = i; last = i; if (prev !== 0 && (v >= 0) !== (prev >= 0)) zc++; prev = v; }
  }
  const seconds = (last - first) / 8000;
  return { seconds, hz: zc / 2 / seconds };
}

beforeAll(async () => {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "libmp3lame", "-b:a", "128k", tone]);
  fileServer = http.createServer((req, res) => { res.writeHead(200, { "content-type": "audio/mpeg", "content-length": fs.statSync(tone).size, "accept-ranges": "none" }); if (req.method !== "HEAD") fs.createReadStream(tone).pipe(res); else res.end(); });
  await new Promise<void>((r) => fileServer.listen(0, "127.0.0.1", () => r()));
  toneUrl = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}/tone.mp3`;
});
afterAll(() => { fileServer?.close(); });

const cand = (over: Partial<Candidate> = {}): Candidate => ({ engine: "ytdlp", sourceId: "generic:tone", title: "Tone", artist: "Test", durationSec: 6, url: toneUrl, score: 1, ...over });

describe.skipIf(!have("yt-dlp"))("yt-dlp engine (real yt-dlp)", () => {
  it("downloads through yt-dlp and ffmpeg into a playable cached file", async () => {
    expect(await ytdlpVersion()).toMatch(/^\d{4}\./);
    const cache = new MusicCache({ engines: { ytdlp: ytdlpEngine }, defaultDir: tmp, sweepMs: 100 });
    const st = await cache.prepare({ cfg: cfgFor(), candidate: cand(), holder: "p", role: "current" });
    const e = cache.get(st.key)!;
    const job = await cache.waitStreamable(e, 30_000);
    await cache.waitReady(job, 30_000);
    const a = analyse(job.finalPath);
    expect(a.seconds).toBeGreaterThan(5.5);
    expect(Math.round(a.hz / 10) * 10).toBe(440);
    cache.release({ holder: "p" });
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.readdirSync(path.join(tmp, "cache", "rift-music"))).toEqual([]);
    await cache.shutdown();
  }, 60_000);

  it("refuses content without an open licence when the policy is licensed-only", async () => {
    const cache = new MusicCache({ engines: { ytdlp: ytdlpEngine }, defaultDir: tmp, sweepMs: 100 });
    const st = await cache.prepare({ cfg: cfgFor({ licensePolicy: "licensed-only" }), candidate: cand({ sourceId: "generic:tone2" }), holder: "p", role: "current" });
    const start = Date.now();
    while (cache.status(cache.get(st.key)!).state !== "failed" && Date.now() - start < 30_000) await new Promise((r) => setTimeout(r, 100));
    expect(cache.status(cache.get(st.key)!).error).toMatch(/open licence/i);
    await cache.shutdown();
  }, 60_000);

  it("reports a clear error for an unreachable source", async () => {
    const cache = new MusicCache({ engines: { ytdlp: ytdlpEngine }, defaultDir: tmp, sweepMs: 100 });
    const st = await cache.prepare({ cfg: cfgFor(), candidate: cand({ sourceId: "generic:dead", url: "http://127.0.0.1:9/none.mp3" }), holder: "p", role: "current" });
    const start = Date.now();
    while (cache.status(cache.get(st.key)!).state !== "failed" && Date.now() - start < 30_000) await new Promise((r) => setTimeout(r, 100));
    expect(cache.status(cache.get(st.key)!).state).toBe("failed");
    expect(fs.readdirSync(path.join(tmp, "cache", "rift-music"))).toEqual([]);
    await cache.shutdown();
  }, 60_000);
});

describe.skipIf(!JAR || !have("java"))("Lavalink engine (real Lavalink node -> Rift voice sink -> browser-ready audio)", () => {
  let ll: ChildProcess;
  let sink: VoiceSink;
  const port = 24333;
  beforeAll(async () => {
    // Trust store = the JVM's default CAs + the sink's self-signed certificate.
    const dir = path.join(tmp, "ll");
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...loadSinkEnv(tmp), tlsDir: path.join(tmp, "sink"), publicHost: "localhost", publicIp: "127.0.0.1", wssPort: 24443, udpPort: 24444 };
    sink = await startSink(env);
    const cacerts = process.env.LAVALINK_CACERTS || /trustStore=([^ ]+)/.exec(process.env.JAVA_TOOL_OPTIONS ?? "")?.[1];
    if (!cacerts) throw new Error("set LAVALINK_CACERTS to the JVM cacerts file");
    const trust = path.join(dir, "trust.jks");
    fs.copyFileSync(cacerts, trust);
    execFileSync("keytool", ["-importcert", "-noprompt", "-alias", "rift-sink", "-file", path.join(env.tlsDir, "cert.pem"), "-keystore", trust, "-storepass", "changeit"], { stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "application.yml"), `server:\n  port: ${port}\n  address: 127.0.0.1\nlavalink:\n  server:\n    password: "e2e"\n    sources:\n      http: true\n`);
    ll = spawn("java", [`-Djavax.net.ssl.trustStore=${trust}`, "-Djavax.net.ssl.trustStorePassword=changeit", "-jar", JAR!], { cwd: dir, stdio: "ignore" });
    const start = Date.now();
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/version`, { headers: { Authorization: "e2e" } })).ok) break; } catch { /* booting */ }
      if (Date.now() - start > 60_000) throw new Error("Lavalink did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 90_000);
  afterAll(async () => { ll?.kill("SIGKILL"); await sink?.stop(); });

  it("plays a track on a real node, captures it through the voice sink, and caches playable audio", async () => {
    const pool = new LavalinkPool();
    const engine = lavalinkEngine(pool, () => sink);
    const cfg = cfgFor({ engine: "lavalink", lavalink: { nodes: [{ id: "n1", name: "local", url: `http://127.0.0.1:${port}`, password: "e2e", searchPrefix: "scsearch" }], allowedSources: ["http"] } });
    const cache = new MusicCache({ engines: { lavalink: engine }, defaultDir: tmp, sweepMs: 100 });
    const found = await engine.search(toneUrl, cfg, 3); // pasted direct link
    expect(found[0]?.sourceName).toBe("http");
    const st = await cache.prepare({ cfg, candidate: found[0], holder: "p", role: "current" });
    const job = await cache.waitStreamable(cache.get(st.key)!, 30_000);
    expect(job.realtime).toBe(true); // paced at playback speed, as documented
    await cache.waitReady(job, 40_000);
    const a = analyse(job.finalPath);
    expect(a.seconds).toBeGreaterThan(5.5);
    expect(a.seconds).toBeLessThan(6.5);
    expect(Math.round(a.hz / 10) * 10).toBe(440);
    cache.release({ holder: "p" });
    await cache.shutdown();
    pool.close();
  }, 90_000);

  it("rejects sources that are not in the allowed list", async () => {
    const pool = new LavalinkPool();
    const engine = lavalinkEngine(pool, () => sink);
    const cfg = cfgFor({ engine: "lavalink", lavalink: { nodes: [{ id: "n1", name: "local", url: `http://127.0.0.1:${port}`, password: "e2e", searchPrefix: "scsearch" }], allowedSources: ["soundcloud"] } });
    expect(await engine.search(toneUrl, cfg, 3)).toEqual([]);
    pool.close();
  }, 30_000);

  it("fails over to another node and reports a dead node clearly", async () => {
    const pool = new LavalinkPool();
    const engine = lavalinkEngine(pool, () => sink);
    const cfg = cfgFor({ engine: "lavalink", lavalink: { nodes: [
      { id: "dead", name: "dead", url: "http://127.0.0.1:9", password: "x", searchPrefix: "scsearch" },
      { id: "n1", name: "local", url: `http://127.0.0.1:${port}`, password: "e2e", searchPrefix: "scsearch" },
    ], allowedSources: ["http"] } });
    await new Promise((r) => setTimeout(r, 1500));
    const found = await engine.search(toneUrl, cfg, 3);
    expect(found[0]?.nodeId).toBe("n1");
    pool.close();
  }, 30_000);
});
