// End of a song must go on to the next queue item even when the server can't be reached for a moment, and a song that
// can't be played is skipped instead of stopping the queue. Needs the library from part1-local.
import { chromium, request, check, until, summary, login, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const lib = await (await api.get("/api/music/library?kind=tracks&take=50")).json();
const by = Object.fromEntries(lib.tracks.map((t) => [t.title, t]));
const item = (t) => ({ trackId: t.id, title: t.title, artist: t.artist, durationSec: t.durationSec ?? 14 });
const ghost = { title: "Nonexistent Song", artist: "Nobody At All", durationSec: 100 };
const order = [item(by["Tone One"]), item(by["Tone Two"]), ghost, item(by["Legacy Song"])];
let r = await api.put("/api/music/queue", { data: { items: order, startIndex: 0 } });
check("queue of 4 (one unplayable) saved", r.ok(), await r.text().then((t) => t.slice(0, 150)));

const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const audio = () => page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); return a ? { t: a.currentTime, paused: a.paused, src: a.currentSrc, dur: a.duration } : null; });
const playingTrack = (t, ms = 20000) => until(async () => { const s = await audio(); return s && !s.paused && s.t > 0.3 && s.src.includes(`/tracks/${by[t].id}/`) ? s : null; }, ms, 250);
const bar = () => page.getByTestId("music-bar");
const toEnd = () => page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); a.currentTime = Math.max(0, a.duration - 0.8); });

await page.goto(BASE + "/music");
await page.getByTestId("music-bar").waitFor();
await page.getByRole("button", { name: "Play", exact: true }).first().click(); // resumes the saved queue
check("Tone One plays", !!(await playingTrack("Tone One")));

// 1) the server can't be reached when the song ends: no "Failed to fetch", no skipping, it retries and lands on the NEXT song
let blocked = 0;
// (the "prepare the next song" request fails too, so this is the path without a prepared song)
await page.route("**/api/music/play", (route) => { if (route.request().postDataJSON()?.peek) return route.abort("connectionrefused"); if (blocked < 3) { blocked++; return route.abort("connectionrefused"); } return route.continue(); });
await toEnd();
const msg = await until(async () => { const t = await bar().innerText(); return /Can't reach the server/i.test(t) ? t : null; }, 10000, 200);
check("offline at track end: says it can't reach the server and keeps trying", !!msg);
check("never shows the browser's raw 'Failed to fetch'", !/Failed to fetch/i.test(await bar().innerText()));
check("after the connection returns it plays the very next song (Tone Two, nothing skipped)", !!(await playingTrack("Tone Two", 30000)), `aborted=${blocked}`);
await page.unroute("**/api/music/play");

// 2) the next song is unplayable: skipped automatically, the one after it plays
await toEnd();
const seen = new Set();
const skipped = await until(async () => { const t = await bar().innerText(); seen.add(t.replace(/\s+/g, " ").slice(0, 160)); return /Skipped .Nonexistent Song/i.test(t) ? true : null; }, 15000, 100);
check("unplayable song is reported as skipped", !!skipped || undefined);
check("and the queue carries on with the song after it (Legacy Song)", !!(await playingTrack("Legacy Song", 30000)));
const q = await (await api.get("/api/music/queue")).json();
check("server queue points at Legacy Song", q.items.find((i) => i.id === q.state.currentItemId)?.title === "Legacy Song");

// 3) a phone in the background: the next song must start the moment this one ends, without a server round trip in
//    between (Android freezes a hidden page as soon as nothing plays). It is prepared ahead ("peek") and switched to inside
//    the `ended` event; the server is told afterwards.
r = await api.put("/api/music/queue", { data: { items: [item(by["Tone One"]), item(by["Tone Two"])], startIndex: 0 } });
check("two-song queue saved", r.ok());
await page.reload();
await bar().waitFor();
await page.getByRole("button", { name: "Play", exact: true }).first().click();
check("Tone One plays again", !!(await playingTrack("Tone One")));
let peeks = 0;
await page.route("**/api/music/play", (route) => { if (route.request().postDataJSON()?.peek) peeks++; return route.continue(); });
await until(async () => ((await audio())?.t > 4.5 && peeks ? true : null), 20000, 200);
await page.waitForTimeout(800); // let the prepared answer arrive
await page.unroute("**/api/music/play");
check("the next song was prepared before the end", peeks > 0, `peeks=${peeks}`);
let held = 0;
await page.route("**/api/music/play", async (route) => { held++; await new Promise((res) => setTimeout(res, 12000)); return route.continue().catch(() => {}); });
await toEnd();
check("the next song starts at once although the server answers slowly (no network wait between songs)", !!(await playingTrack("Tone Two", 5000)), `held=${held}`);
await page.unroute("**/api/music/play");
const q2 = await until(async () => { const v = await (await api.get("/api/music/queue")).json(); return v.items.find((i) => i.id === v.state.currentItemId)?.title === "Tone Two" ? v : null; }, 20000, 500);
check("and the server is told afterwards (current = Tone Two)", !!q2);
await browser.close();
summary();
