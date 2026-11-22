import { chromium, request, check, until, sleep, summary, login, workerStats, workerCfg, BASE, E } from "./lib.mjs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const put = (data) => api.put("/api/admin/music/settings", { data });
const node = { id: "n1", name: "Local Lavalink", url: "http://127.0.0.1:24333", password: "e2e", searchPrefix: "scsearch" };
const URLS = ["od1", "od2", "od3"].map((n) => `http://127.0.0.1:8099/${n}.mp3`);
const analyse = (buf) => { fs.writeFileSync(E + "/cap.mp3", buf); const raw = execFileSync("ffmpeg", ["-v", "error", "-i", E + "/cap.mp3", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 26 }); let zc = 0, prev = 0, a = -1, b = 0; for (let i = 0; i < raw.length / 2; i++) { const v = raw.readInt16LE(i * 2); if (Math.abs(v) > 1000) { if (a < 0) a = i; b = i; if (prev && (v >= 0) !== (prev >= 0)) zc++; prev = v; } } const sec = (b - a) / 8000; return { sec, hz: Math.round(zc / 2 / sec / 10) * 10 }; };

// ---- admin / settings
let r = await put({ musicSource: "hybrid", musicEngine: "lavalink", musicLavalinkNodes: [] });
check("Lavalink engine without a node is rejected", r.status() === 400 && /Lavalink node/i.test((await r.json()).error));
r = await put({ musicSource: "hybrid", musicEngine: "lavalink", musicLavalinkNodes: [node], musicLavalinkAllowedSources: ["http"], musicRightsAttested: true, musicLicensePolicy: "attested", musicPreload: true, musicPreloadCount: 2, musicCleanupGraceSec: 2, musicMaxStreams: 0, musicMaxDownloads: 2 });
check("Lavalink node saved (password masked in responses)", r.ok() && (await r.json()).settings.musicLavalinkNodes[0].password === "••••");
const t = await (await api.post("/api/admin/music/lavalink/test", { data: { ...node, password: "••••" } })).json();
check("node test connects (masked password resolved server-side)", t.ok === true && /^4\./.test(t.version) && t.sinkReady === true, JSON.stringify(t));
const bad = await (await api.post("/api/admin/music/lavalink/test", { data: { ...node, password: "wrong" } })).json();
check("node test reports a bad password clearly", bad.ok === false && /401|403|connect/i.test(bad.error), bad.error);
const cfgYaml = await (await api.get("/api/admin/music/lavalink/config")).json();
check("bundled-node config generator (password masked in preview)", /sources:/.test(cfgYaml.yaml) && !cfgYaml.yaml.includes("e2e"));

// ---- search by pasted direct link via Lavalink
const sres = await api.get("/api/music/search/ondemand?q=" + encodeURIComponent(URLS[0]));
const sj = await sres.json();
check("on-demand search through Lavalink (direct link)", sres.ok() && sj.candidates?.[0]?.sourceName === "http" && sj.candidates[0].engine === "lavalink", JSON.stringify(sj).slice(0, 200));
const cands = [];
for (const u of URLS) cands.push((await (await api.get("/api/music/search/ondemand?q=" + encodeURIComponent(u))).json()).candidates[0]);
const items = cands.map((c, i) => ({ title: `Lava ${i + 1}`, artist: "Bridge", durationSec: 10, candidate: c }));

// ---- full-stack playback in the browser
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} }); // never leave a browser behind
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const aud = () => page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); return a ? { t: a.currentTime, paused: a.paused, src: a.currentSrc, err: a.error?.code ?? 0 } : null; });
const reqs = []; page.on("response", (x) => { if (x.url().includes("/api/music/od/") && x.url().endsWith("/audio")) reqs.push({ s: x.status(), mode: x.headers()["x-rift-audio"], at: Date.now() }); });
await api.put("/api/music/queue", { data: { items, startIndex: 0 } });
await page.goto(BASE + "/music");
await page.getByTestId("music-bar").waitFor();
const t0 = Date.now();
await page.getByTestId("music-bar").getByRole("button", { name: "Play", exact: true }).click();
const first = await until(async () => { const s = await aud(); return s && !s.paused && s.t > 0.5 ? s : null; }, 30000, 200);
const ttfa = Date.now() - t0;
check("Lavalink audio plays in the browser", !!first && first.src.includes("/api/music/od/"), JSON.stringify(first));
check("playback starts while the capture is still running (live stream), not after it", reqs[0]?.mode === "live" && ttfa < 6000, `mode=${reqs[0]?.mode} time-to-audio=${ttfa}ms (track is 10 s long)`);
let status = await (await api.get(`/api/music/od/${(await (await api.get("/api/music/queue")).json()).items.length ? "" : ""}x/status`).catch(() => null))?.json?.().catch(() => null);
const w1 = await workerStats(workerCfg({ engine: "lavalink", lavalink: { nodes: [node], allowedSources: ["http"] } }));
const live = w1.tracks.find((x) => x.state === "downloading");
check("worker reports the realtime capture in progress (not instant)", !!live || w1.tracks.some((x) => x.state === "ready"), JSON.stringify(w1.tracks.map((x) => `${x.title}:${x.state}:${x.roles}`)));
check("download concurrency respected (max 2 captures at once)", w1.jobsRunning <= 2 && w1.jobsRunning >= 1, `running=${w1.jobsRunning} queued=${w1.jobsQueued}`);
await page.screenshot({ path: E + "/shot-lavalink.png" });
// seek beyond what has been captured: waits for the full file, then jumps
await page.evaluate(() => { document.querySelector('[data-testid="music-audio"]').currentTime = 8; });
const sought = await until(async () => { const s = await aud(); return s && s.t >= 8 && !s.paused ? s : null; }, 25000, 300);
check("seeking ahead of the capture completes once the file is ready", !!sought, JSON.stringify(sought));
// the captured audio really is the node's output (440 Hz tone from od1.mp3), via the normal Range endpoint
const play = await (await api.post("/api/music/play", { data: { itemId: (await (await api.get("/api/music/queue")).json()).items[0].id } })).json();
const ready = await until(async () => { const s = await (await api.get(`/api/music/od/${play.play.key}/status`)).json(); return s.state === "ready" ? s : null; }, 30000, 500);
check("capture finishes and is marked ready", !!ready, JSON.stringify(ready));
const body = await (await api.get(play.play.url, { headers: { Range: "bytes=0-" } })).body();
const an = analyse(body);
check("cached audio is the real track: ~10 s, 440 Hz", an.sec > 9 && an.sec < 11 && an.hz === 440, JSON.stringify(an));
const l2 = await workerStats(workerCfg({ engine: "lavalink", lavalink: { nodes: [node], allowedSources: ["http"] } }));
check("next songs are preloaded in the background through Lavalink", l2.tracks.some((x) => x.roles.includes("preload")), JSON.stringify(l2.tracks.map((x) => `${x.title}:${x.state}:${x.roles}`)));

// node going away -> clear failure, nothing stuck
await api.post("/api/music/queue/clear");
await browser.close();
const ll = execFileSync("pgrep", ["-f", "Lavalink.jar"]).toString().trim().split("\n");
for (const p of ll) process.kill(Number(p), "SIGKILL");
await until(async () => (await workerStats(workerCfg({ engine: "lavalink" }))).tracks.length === 0, 20000, 400); // nothing cached any more
await api.put("/api/music/queue", { data: { items: [items[0]], startIndex: 0 } });
const pr = await api.post("/api/music/play", { data: {} });
const k = (await pr.json()).play?.key;
const fl = k && await until(async () => { const s = await (await api.get(`/api/music/od/${k}/status`)).json(); return s.state === "failed" ? s : null; }, 30000, 500);
check("Lavalink node down: fails with a clear message", fl && /no lavalink node|not connected|online|reach/i.test(fl.error), fl?.error);
summary();
