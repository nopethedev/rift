import { chromium, request, check, until, sleep, summary, login, BASE, E } from "./lib.mjs";
import fs from "node:fs";
const api = await request.newContext({ baseURL: BASE });
const profileId = await login(api);
check("setup + login + profile select", !!profileId);

// ---- settings + scan
let r = await api.put("/api/admin/music/settings", { data: { musicLibraryDirs: [E + "/media/music"], musicUploadDir: E + "/media/music/uploads" } });
check("music settings saved", r.ok(), await r.text().then((t) => t.slice(0, 120)));
await api.post("/api/admin/music/scan");
const st = await until(async () => { const s = await (await api.get("/api/admin/music/status")).json(); return s.scan.last && !s.scan.running ? s : null; }, 60000, 500);
check("scan finished", !!st, JSON.stringify(st?.scan?.last));
check("7 tracks indexed (mp3, flac, ogg, opus, wav, m4a, wma)", st?.library.tracks === 7, `tracks=${st?.library.tracks} errors=${JSON.stringify(st?.scan?.last?.errors)}`);
check("2 albums, 2 artists", st?.library.albums === 2 && st?.library.artists === 2, `albums=${st?.library.albums} artists=${st?.library.artists}`);
const lib = await (await api.get("/api/music/library?kind=tracks&take=50")).json();
const by = Object.fromEntries(lib.tracks.map((t) => [t.title, t]));
check("tags: title/artist/album/genre/year/track", by["Tone One"]?.artist === "Test Artist" && by["Tone One"]?.album === "Test Album" && by["Tone One"]?.genre === "Electronic" && by["Tone One"]?.year === 2021 && by["Tone One"]?.trackNo === 1, JSON.stringify(by["Tone One"]));
check("cover art extracted for tagged mp3", !!by["Tone One"]?.coverUrl);
const cov = by["Tone One"]?.coverUrl ? await api.get(by["Tone One"].coverUrl) : null;
check("cover served as image/jpeg", cov?.ok() && cov.headers()["content-type"] === "image/jpeg", cov && String((await cov.body()).length));
check("codecs detected", ["mp3", "flac", "vorbis", "opus", "pcm_s16le", "aac", "wmav2"].every((c) => lib.tracks.some((t) => t.codec === c)), lib.tracks.map((t) => t.codec).join(","));
check("unknown-album tracks grouped as singles", lib.tracks.filter((t) => t.artist === "Other Artist").length === 3);
// rescan skips unchanged
await api.post("/api/admin/music/scan");
const st2 = await until(async () => { const s = await (await api.get("/api/admin/music/status")).json(); return s.scan.last && !s.scan.running && s.scan.finishedAt !== st.scan.finishedAt ? s : null; }, 30000, 300);
check("rescan adds nothing", st2?.scan.last.added === 0 && st2?.library.tracks === 7);

// ---- direct HTTP: Range + transcode
const t1 = by["Tone One"];
const rg = await api.get(`/api/music/tracks/${t1.id}/audio`, { headers: { Range: "bytes=100-199" } });
check("local audio Range -> 206", rg.status() === 206 && rg.headers()["content-range"]?.startsWith("bytes 100-199/") && (await rg.body()).length === 100);
const tc = await api.get(`/api/music/tracks/${by["Legacy Song"].id}/audio?transcode=1&start=2`);
check("wma converted on the fly to audio/mpeg", tc.ok() && tc.headers()["content-type"] === "audio/mpeg" && (await tc.body()).length > 20000, `${tc.status()} ${tc.headers()["content-type"]}`);

// ---- browser
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} }); // never leave a browser behind
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, storageState: await api.storageState() });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const audioState = () => page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); return a ? { t: a.currentTime, paused: a.paused, src: a.currentSrc, dur: a.duration, err: a.error?.code ?? 0 } : null; });
const playing = async (min = 1.5, ms = 20000) => until(async () => { const s = await audioState(); return s && !s.paused && s.t > min ? s : null; }, ms, 250);

await page.goto(BASE + "/music/library");
await page.getByRole("tab", { name: "albums" }).waitFor();
check("library page lists albums", await until(async () => (await page.locator('a[href^="/music/albums/"]').count()) === 2, 15000));
await page.screenshot({ path: E + "/shot-library.png" });
await page.getByRole("link", { name: /Test Album/ }).first().click();
await page.getByRole("heading", { name: "Test Album" }).waitFor();
await page.getByRole("button", { name: "Play Tone One" }).click();
let s = await playing();
check("mp3 plays in the browser (direct, Range)", s && s.src.includes(`/api/music/tracks/${t1.id}/audio`) && !s.src.includes("transcode"), JSON.stringify(s));
await page.screenshot({ path: E + "/shot-album.png" });
check("player bar shows the track", await page.getByTestId("music-bar").getByText("Tone One").isVisible());
// seek
await page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); a.currentTime = 9; });
s = await until(async () => { const x = await audioState(); return x.t > 9.2 ? x : null; }, 5000);
check("seeking works on direct playback", !!s, s && String(s.t));
// next -> flac, ogg, opus
const names = ["Tone Two", "Tone Three", "Tone Four"];
for (const n of names) {
  await page.getByRole("button", { name: "Next" }).first().click();
  await page.getByTestId("music-bar").getByText(n, { exact: true }).waitFor();
  const x = await playing();
  check(`next -> ${n} plays (${n === "Tone Two" ? "flac" : n === "Tone Three" ? "ogg/vorbis" : "opus"})`, !!x, JSON.stringify(x));
}
// end of the album: autoplay appends library recommendations and keeps going
await page.getByRole("button", { name: "Next" }).first().click();
await sleep(2500);
const q1 = await (await api.get("/api/music/queue")).json();
check("autoplay extends the queue at the end", q1.items.length > 4 && q1.items.some((i) => i.origin === "autoplay"), `items=${q1.items.length}`);
const x5 = await playing();
check("autoplay track plays", !!x5, JSON.stringify(x5));

// AAC: chromium without proprietary codecs -> client reports it, server converts
await page.goto(BASE + "/music/search?q=Aac");
await page.getByRole("button", { name: "Play Aac Song" }).click();
await page.getByTestId("music-bar").getByText("Aac Song").waitFor();
s = await playing();
const aacSrc = s?.src ?? "";
check("m4a/AAC plays (converted when the browser can't decode it)", !!s, aacSrc);
console.log("   aac src:", aacSrc.replace(BASE, ""));
// wma -> transcode + seek by restart
await page.goto(BASE + "/music/search?q=Legacy");
await page.getByRole("button", { name: "Play Legacy Song" }).click();
s = await playing(1.0);
check("wma plays via on-the-fly conversion", s && s.src.includes("transcode=1"), JSON.stringify(s));
await page.getByRole("button", { name: "Open now playing" }).click();
const slider = page.getByRole("slider", { name: "Seek" }).last();
await slider.waitFor();
await slider.evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "9"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
s = await until(async () => { const x = await audioState(); return x.src.includes("start=9") && x.t >= 0.3 ? x : null; }, 8000);
check("seek on converted audio restarts the stream at the offset", !!s, s && s.src.replace(BASE, ""));
const pos = await page.getByRole("slider", { name: "Seek" }).last().inputValue();
check("seek bar shows offset + elapsed time", Number(pos) >= 9, pos);
await page.screenshot({ path: E + "/shot-nowplaying.png" });
await page.keyboard.press("Escape");

// persistence: reload keeps the queue and the current item
const q2 = await (await api.get("/api/music/queue")).json();
await page.goto(BASE + "/music");
await page.getByTestId("music-bar").waitFor();
check("queue + current track survive a reload", (await page.getByTestId("music-bar").innerText()).includes("Legacy Song") && q2.state.currentItemId, "");
// shuffle / repeat / autoplay persistence via API
await api.patch("/api/music/queue/state", { data: { shuffle: true, repeat: "all" } });
const q3 = await (await api.get("/api/music/queue")).json();
check("shuffle + repeat persisted", q3.state.shuffle && q3.state.repeat === "all");
await api.patch("/api/music/queue/state", { data: { shuffle: false, repeat: "off" } });

// history + home recommendations
const home = await (await api.get("/api/music/home")).json();
check("home: recently played populated from history", home.recentlyPlayed.length > 0, `n=${home.recentlyPlayed.length}`);
check("home: made-for-you populated", home.madeForYou.length > 0);
await page.screenshot({ path: E + "/shot-home.png" });
check("no browser errors during local playback", errs.filter((e) => !/favicon|404|Failed to load resource.*(cover|_next)|hydrat|caret-color|hmr/i.test(e)).length === 0, errs.slice(0, 3).join(" | "));
await browser.close();
summary();
