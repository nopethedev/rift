import { chromium, request, check, until, sleep, summary, login, workerStats, workerCfg, BASE, E } from "./lib.mjs";
import fs from "node:fs";
const api = await request.newContext({ baseURL: BASE });
const profileId = await login(api);
const put = (data) => api.put("/api/admin/music/settings", { data });
const item = (title, durationSec = 10) => ({ title, artist: "Demo Artist", durationSec });
const tracks = async () => (await workerStats()).tracks ?? [];
const names = async () => (await tracks()).map((t) => `${t.title}:${t.roles.join("+") || "-"}:${t.state}`).sort();
const cacheFiles = () => { try { return fs.readdirSync(E + "/transcode/music-cache/rift-music"); } catch { return []; } };

// ---- 1. rights gate
await put({ musicSource: "hybrid", musicEngine: "ytdlp", musicRightsAttested: false, musicLicensePolicy: "attested", musicSearchProviders: ["soundcloud"], musicPreload: true, musicPreloadCount: 2, musicCacheCleanup: true, musicCleanupGraceSec: 2, musicMaxStreams: 0, musicBitrate: 128 });
let r = await api.put("/api/music/queue", { data: { items: [item("Alpha Track")], startIndex: 0 } });
r = await api.post("/api/music/play", { data: {} });
check("on-demand refused until the admin attests rights", r.status() === 409 && /confirm the rights/i.test((await r.json()).error), `${r.status()}`);
const modeOff = (await (await api.get("/api/music/home")).json()).mode;
check("mode reports on-demand unavailable + reason", modeOff.onDemand === false && !!modeOff.onDemandReason);

// ---- 2. matching: decoys (live / remix) must lose to the studio upload
await put({ musicRightsAttested: true });
await api.put("/api/music/queue", { data: { items: [{ title: "Ondemand Song", artist: "Demo Artist", durationSec: 10 }], startIndex: 0 } });
r = await api.post("/api/music/play", { data: {} });
const pj = await r.json();
check("on-demand play prepares audio", r.ok() && pj.play?.kind === "ondemand" && /^[0-9a-f]{24}$/.test(pj.play.key), JSON.stringify(pj.play ?? pj).slice(0, 160));
const st = await until(async () => { const s = await (await api.get(`/api/music/od/${pj.play.key}/status`)).json(); return s.state === "ready" ? s : null; }, 20000, 300);
check("capture completes", !!st, JSON.stringify(st));
check("matcher chose the studio upload, not the live/remix decoys", st?.candidate?.sourceId === "soundcloud:od1", st?.candidate?.sourceId);
const audio = await api.get(pj.play.url, { headers: { Range: "bytes=0-" } }); // what <audio> sends
const total = Number(/\/(\d+)$/.exec(audio.headers()["content-range"] ?? "")?.[1]);
check("on-demand audio: browser-style Range request -> 206 with total size, audio/mpeg", audio.status() === 206 && audio.headers()["content-type"] === "audio/mpeg" && total > 100000 && (await audio.body()).length === total, `${audio.status()} ${audio.headers()["content-range"]}`);
const rg = await api.get(pj.play.url, { headers: { Range: "bytes=1000-1999" } });
check("on-demand audio supports Range (seek) once cached", rg.status() === 206 && (await rg.body()).length === 1000);
await api.post("/api/music/queue/clear");
check("clearing the queue frees the audio after the grace period", !!(await until(async () => (await tracks()).length === 0 && cacheFiles().length === 0, 12000, 300)), JSON.stringify(cacheFiles()));

// ---- 3. browser: queue of four distinct on-demand songs, preload exactly the next two
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} }); // never leave a browser behind
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const aud = () => page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); return a ? { t: a.currentTime, paused: a.paused, src: a.currentSrc, err: a.error?.code ?? 0 } : null; });
const playing = (min = 1.2, ms = 25000) => until(async () => { const s = await aud(); return s && !s.paused && s.t > min ? s : null; }, ms, 250);
const hdrs = []; page.on("response", (x) => { if (x.url().includes("/api/music/od/") && x.url().endsWith("/audio")) hdrs.push({ status: x.status(), mode: x.headers()["x-rift-audio"] }); });
await api.put("/api/music/queue", { data: { items: ["Alpha Track", "Beta Track", "Gamma Track", "Delta Track"].map((t) => item(t)), startIndex: 0 } });
await page.goto(BASE + "/music");
await page.getByTestId("music-bar").waitFor();
await page.getByTestId("music-bar").getByRole("button", { name: "Play", exact: true }).click();
let s = await playing();
check("on-demand track plays in the browser", s && s.src.includes("/api/music/od/"), JSON.stringify(s));
check("served from the worker cache pipeline", hdrs.length > 0 && hdrs.every((h) => h.status === 200 || h.status === 206), JSON.stringify(hdrs));
let list = await until(async () => { const l = await names(); return l.length === 3 && l.every((n) => !n.endsWith("downloading") && !n.endsWith("queued") && !n.endsWith("resolving")) ? l : null; }, 25000, 400);
check("exactly the current + next TWO songs are cached (Delta is not preloaded)", Array.isArray(list) && list.join(",") === "Alpha Track:current:ready,Beta Track:preload:ready,Gamma Track:preload:ready", JSON.stringify(list || await names()));
await page.screenshot({ path: E + "/shot-ondemand.png" });
// queue change: remove Beta -> its preload is cancelled, Delta takes the second slot
const q = await (await api.get("/api/music/queue")).json();
const beta = q.items.find((i) => i.title === "Beta Track");
await api.post("/api/music/queue/remove", { data: { id: beta.id } });
list = await until(async () => { const l = await names(); return l.length === 3 && l.some((n) => n.startsWith("Delta Track:preload")) && !l.some((n) => n.startsWith("Beta Track")) ? l : null; }, 20000, 400);
check("removing a queued song cancels its preload and preloads the next one", Array.isArray(list), JSON.stringify(list || await names()));
// next: Gamma was preloaded, so it is already ready when we skip to it
await page.getByRole("button", { name: "Next" }).first().click();
await page.getByTestId("music-bar").getByText("Gamma Track").waitFor();
s = await playing();
check("skip to a preloaded song plays", !!s, JSON.stringify(s));
list = await until(async () => { const l = await names(); return l.some((n) => n.startsWith("Gamma Track:current")) && l.some((n) => n.startsWith("Delta Track:preload")) ? l : null; }, 15000, 400);
check("after skipping, previous track is released and next stays preloaded", Array.isArray(list) && !list.some((n) => n.startsWith("Alpha Track:current")), JSON.stringify(list || await names()));
const before = await names();
// pause -> hold stays (heartbeat), seek in cached on-demand audio
await page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); a.currentTime = 6; });
s = await until(async () => { const x = await aud(); return x.t > 6.2 ? x : null; }, 6000);
check("seeking in cached on-demand audio", !!s, s && String(s.t));

await api.post("/api/music/queue/clear");
await browser.close();
check("everything is released when the listener leaves", !!(await until(async () => (await tracks()).length === 0 && cacheFiles().length === 0, 15000, 300)), JSON.stringify(await names()));

// ---- 4. listener limit (profile 1 holds the only slot)
await api.put("/api/music/queue", { data: { items: [item("Alpha Track")], startIndex: 0 } });
await api.post("/api/music/play", { data: {} });
const prof2 = await api.post("/api/profiles", { data: { name: "Guest", avatar: "crown:violet" } });
const p2id = (await prof2.json()).id;
await put({ musicMaxStreams: 1 });
const api2 = await request.newContext({ baseURL: BASE });
await api2.post("/api/auth/login", { data: { username: "admin", password: "Sup3r-secret-pass!" } });
await api2.post("/api/profiles/" + p2id, { data: {} });
await api2.put("/api/music/queue", { data: { items: [item("Alpha Track")], startIndex: 0 } });
r = await api2.post("/api/music/play", { data: {} });
check("a second listener beyond the limit is refused with a clear message", r.status() === 429 && /limit/i.test((await r.json()).error), `${r.status()}`);
await put({ musicMaxStreams: 0 });
r = await api2.post("/api/music/play", { data: {} });
check("…and is admitted once the limit is lifted", r.ok());
await api2.post("/api/music/queue/clear");
await api.delete("/api/profiles/" + p2id, { data: {} }).catch(() => {});

// ---- 5. licence gate
await api.post("/api/music/queue/clear");
await until(async () => (await tracks()).length === 0, 15000, 300);
await put({ musicLicensePolicy: "licensed-only" });
await api.put("/api/music/queue", { data: { items: [item("Alpha Track")], startIndex: 0 } });
r = await api.post("/api/music/play", { data: {} });
const key = (await r.json()).play?.key;
const failed = await until(async () => { const x = await (await api.get(`/api/music/od/${key}/status`)).json(); return x.state === "failed" ? x : null; }, 20000, 300);
check("licensed-only policy refuses content without an open licence", failed && /open licence/i.test(failed.error), failed?.error);
const au = await api.get(`/api/music/od/${key}/audio`);
check("…and the audio endpoint returns a clear error (no partial file)", au.status() === 502 && /licence/i.test((await au.json()).error), `${au.status()}`);
check("…nothing left in the cache", !!(await until(async () => cacheFiles().length === 0, 12000, 300)), JSON.stringify(cacheFiles()));
await put({ musicLicensePolicy: "attested" });

// ---- 6. preload off
await sleep(4500); // let the failed entry age past its retry back-off
await api.put("/api/music/queue", { data: { items: ["Alpha Track", "Beta Track", "Gamma Track"].map((t) => item(t)), startIndex: 0 } });
await put({ musicPreload: false });
await api.post("/api/music/play", { data: {} });
await sleep(4000);
const l6 = await names();
check("preloading can be disabled (only the current song is fetched)", l6.length === 1 && l6[0].startsWith("Alpha Track:current"), JSON.stringify(l6));
await api.post("/api/music/queue/clear");
await put({ musicPreload: true });

// admin status shows cache stats
await sleep(100);
const adm = await (await api.get("/api/admin/music/status")).json();
check("admin status reports engine + cache", adm.worker.ok && adm.worker.engine === "ytdlp" && adm.worker.ytdlp.available && adm.worker.maxCacheBytes > 0, JSON.stringify(adm.worker).slice(0, 160));
summary();
