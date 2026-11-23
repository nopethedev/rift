// Album art, music feed, artist profile, liked songs / manual matching, engine "auto", app picker and the Spotify-style UI.
// The catalogue APIs are served by fake-catalog.mjs (no internet needed).
import { chromium, request, check, until, sleep, summary, login, workerCfg, BASE, E } from "./lib.mjs";
const CAT = "http://localhost:8098";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const put = (data) => api.put("/api/admin/music/settings", { data });
await put({ musicSource: "hybrid", musicEngine: "auto", musicMetadata: true, musicRightsAttested: true, musicLicensePolicy: "attested", musicSearchProviders: ["soundcloud"], musicPreload: false, musicCleanupGraceSec: 2 });
const stats = async () => (await fetch(CAT + "/__stats")).json();
const j = async (p) => { const r = await api.get(p); return { status: r.status(), body: await r.json().catch(() => null) }; };

// ---- feed
let r = await j("/api/music/feed");
const ids = r.body?.shelves?.map((s) => s.id) ?? [];
check("feed has trending, new releases, popular artists and top albums", ["trending", "releases", "artists", "albums"].every((i) => ids.includes(i)), ids.join(","));
check("feed lists genres without the 'All' pseudo-genre", r.body.genres.length === 3 && !r.body.genres.some((g) => g.name === "All"), JSON.stringify(r.body.genres.map((g) => g.name)));
const trending = r.body.shelves.find((s) => s.id === "trending");
check("feed tracks carry title, artist, album and cover", trending.tracks[0].title === "Alpha Track" && trending.tracks[0].artist === "Demo Artist" && trending.tracks[0].artworkUrl?.startsWith(CAT), JSON.stringify(trending.tracks[0]));
const before = (await stats())["/chart/0"];
await j("/api/music/feed");
check("a repeated feed request is served from cache", (await stats())["/chart/0"] === before, `${before} -> ${(await stats())["/chart/0"]}`);
check("placeholder artist pictures (Deezer's blank image) are treated as missing", r.body.shelves.find((s) => s.id === "artists").artists.find((a) => a.name === "Demo Artist").pictureUrl === null);

// ---- artwork proxy
const art = (u) => api.get("/api/music/art?u=" + encodeURIComponent(u));
let a = await art(CAT + "/img/cover-11.jpg");
check("allow-listed artwork is fetched and served as an image", a.ok() && a.headers()["content-type"] === "image/jpeg" && (await a.body()).length > 1000);
for (const bad of ["http://127.0.0.1:4100/health", "https://example.com/x.jpg", "file:///etc/passwd", "http://localhost:3100/api/music/home", "http://user:pw@localhost:8098/img/x.jpg"])
  check(`artwork proxy refuses ${bad.slice(0, 40)}`, (await art(bad)).status() === 400);
const anon = await request.newContext({ baseURL: BASE });
check("artwork proxy needs a session", (await anon.get("/api/music/art?u=" + encodeURIComponent(CAT + "/img/cover-11.jpg"))).status() === 401);

// ---- artist profile / album / genre
r = await j("/api/music/online/artist?name=Test%20Artist");
const pf = r.body?.profile;
check("artist profile found by name with fans, bio and link", pf?.artist.id === "1" && pf.artist.fans === 123456 && /electronic music band/.test(pf.bio?.text ?? "") && /wikipedia/.test(pf.bio?.url ?? ""), JSON.stringify(pf?.bio)?.slice(0, 80));
check("artist top tracks and related artists", pf.topTracks.length === 1 && pf.topTracks[0].title === "Tone One" && pf.related.length === 2);
// Spotify-style "Popular": 5 songs, "See more" -> 10, "Show all" -> every song (duplicates of one song merged), "Show less" -> 5
{
  const b = await chromium.launch();
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 }, storageState: await api.storageState() })).newPage();
  await pg.goto(BASE + "/music/artists/Prolific%20Artist?id=4");
  const rows = () => pg.getByRole("button", { name: /^Play Hit Number/ }).count();
  await pg.getByRole("heading", { name: "Popular" }).waitFor();
  check("artist Popular starts with 5 songs", (await rows()) === 5, String(await rows()));
  await pg.getByRole("button", { name: "See more" }).click();
  check("See more shows 10", (await rows()) === 10, String(await rows()));
  await pg.getByRole("button", { name: /Show all 14 songs/ }).click();
  check("Show all lists every song once (14 distinct, the duplicate merged)", (await rows()) === 14, String(await rows()));
  await pg.getByRole("button", { name: "Show less" }).click();
  check("Show less goes back to 5", (await rows()) === 5, String(await rows()));
  await b.close();
}
check("discography is newest-first with duplicate titles merged", pf.albums.map((x) => x.title).join("|") === "Lone Single|Test Album (Deluxe)|Test Album", pf.albums.map((x) => x.title).join("|"));
check("album kinds are mapped (single)", pf.albums[0].kind === "single");
r = await j("/api/music/online/artist?name=Other%20Artist");
check("a disambiguation page is not used as a biography", r.body?.profile?.artist.id === "2" && r.body.profile.bio === null);
r = await j("/api/music/online/artist?name=Nobody%20Famous");
check("unknown artists return no profile (not an error)", r.status === 200 && r.body.profile === null);
r = await j("/api/music/online/artist?id=abc");
check("bad artist id is rejected", r.status === 400);
r = await j("/api/music/online/album/14");
check("album detail has tracks with the album cover", r.body?.tracks.length === 2 && r.body.tracks[0].albumId === "14" && r.body.tracks[0].artworkUrl?.includes("cover-14") && r.body.album.label === "Rift Records", JSON.stringify(r.body?.tracks?.[0]));
r = await j("/api/music/online/genre/132");
check("genre page has charts", r.body?.genre.name === "Pop" && r.body.tracks.length === 4);
r = await j("/api/music/online/search?q=Alpha%20Track");
check("catalogue search returns artists, albums and songs", r.body && "artists" in r.body && r.body.tracks.some((t) => t.title === "Alpha Track"));
await fetch(CAT + "/__down?on=1");
r = await j("/api/music/online/artist?id=3");
check("an unreachable catalogue gives a readable error, not a crash", r.status === 502 && /Deezer|answered 503|Could not reach/.test(r.body?.error ?? ""), `${r.status} ${r.body?.error}`);
r = await j("/api/music/feed");
check("the (cached) feed still loads while the catalogue is down", r.status === 200 && r.body.shelves.length > 0);
await fetch(CAT + "/__down?on=0");
await put({ musicMetadata: false });
r = await j("/api/music/feed");
check("feed is empty and says so when online info is switched off", r.body.enabled === false && r.body.shelves.length === 0);
r = await j("/api/music/online/artist?name=Test%20Artist");
check("online endpoints refuse when switched off", r.status === 409);
await put({ musicMetadata: true });

// ---- album art for library tracks without a cover
// The scan queues a background lookup by itself: nobody has to press a button.
await api.post("/api/admin/music/scan"); await until(async () => { const s = await (await api.get("/api/admin/music/status")).json(); return !s.scan.running && s.library.tracks >= 7; }, 40000, 400);
const tracks = async () => (await (await api.get("/api/music/library?kind=tracks&take=100")).json()).tracks;
const by = (t, title) => t.find((x) => x.title === title);
let t = await tracks();
const filled = await until(async () => { t = await tracks(); return by(t, "Wave Song")?.coverUrl && by(t, "Tone Two")?.coverUrl ? t : null; }, 30000, 500);
check("after a scan, tracks without a cover get one automatically", !!filled, JSON.stringify({ wave: by(t, "Wave Song")?.coverUrl, tone2: by(t, "Tone Two")?.coverUrl }));
check("a song gets its album's cover from Deezer (one lookup per album)", by(t, "Tone Two")?.coverUrl === by(t, "Tone Three")?.coverUrl && !!by(t, "Tone Two")?.coverUrl);
check("falls back to iTunes when Deezer has no match", !!by(t, "Wave Song")?.coverUrl && ((await stats())["/itunes/search"] ?? 0) >= 1, JSON.stringify((await stats())["/itunes/search"]));
const cv = await api.get(by(t, "Tone Two").coverUrl);
check("the fetched cover is stored locally as a JPEG", cv.ok() && cv.headers()["content-type"] === "image/jpeg");
check("embedded covers are never replaced", by(t, "Tone One").coverUrl && by(t, "Tone One").coverUrl !== by(t, "Tone Two").coverUrl);
const albumLookups = (await stats())["/search/album"];
r = await api.post("/api/admin/music/artwork"); const fill = await r.json();
check("the admin 'fetch missing art' action works and finds nothing left to do", r.ok() && fill.result.albums === 0, JSON.stringify(fill));
await api.post("/api/admin/music/scan"); await sleep(8000);
check("later scans do not repeat lookups", (await stats())["/search/album"] === albumLookups, `${albumLookups} -> ${(await stats())["/search/album"]}`);

// ---- liked songs + manual matching
const lib = await tracks();
r = await api.post("/api/music/saved", { data: { title: "Alpha Track", artist: "Demo Artist", album: "Demo Hits", durationSec: 10, artworkUrl: CAT + "/img/cover-14.jpg" } });
let first = (await r.json()).item;
check("saving an unowned song keeps it as an unmatched reference", r.ok() && first.match === "unmatched" && first.trackId === null, JSON.stringify(first));
await api.post("/api/music/saved", { data: { title: "Alpha Track", artist: "Demo Artist" } });
r = await api.post("/api/music/saved", { data: { trackId: lib.find((x) => x.title === "Tone Two").id } });
check("saving a library file", r.ok() && (await r.json()).item.match === "local");
let keys = (await (await api.get("/api/music/saved?keys=1")).json()).keys;
check("saving twice does not duplicate; keys use artist|title", keys.length === 2 && keys.includes("demo artist|alpha track"), JSON.stringify(keys));
// a song that exists in the library is matched on save
r = await api.post("/api/music/saved", { data: { title: "Wave Song", artist: "Other Artist", durationSec: 14 } });
check("an external song that exists in the library is linked to it", (await r.json()).item.match === "local");
// manual match: forged candidate refused, real one accepted
r = await api.patch(`/api/music/saved/${first.id}`, { data: { candidate: { engine: "ytdlp", sourceId: "x", title: "x", artist: "x", durationSec: 1, url: "file:///etc/passwd", score: 1, sig: "forged" } } });
check("a forged on-demand match is refused", r.status() === 400);
const found = await (await api.get("/api/music/search/ondemand?q=Alpha%20Track")).json();
const pick = found.candidates.find((c) => c.sourceId === "soundcloud:alpha");
check("on-demand search (engine auto, no Lavalink node) finds the yt-dlp result", !!pick && pick.engine === "ytdlp", JSON.stringify(found.candidates?.map((c) => c.sourceId)));
r = await api.patch(`/api/music/saved/${first.id}`, { data: { candidate: pick } });
let list = (await (await api.get("/api/music/saved")).json()).items;
check("matching by hand pins the chosen on-demand source", r.ok() && list.find((x) => x.id === first.id).match === "ondemand");
r = await api.patch(`/api/music/saved/${first.id}`, { data: { trackId: lib.find((x) => x.title === "Tone One").id } });
list = (await (await api.get("/api/music/saved")).json()).items;
check("…or to a library track", r.ok() && list.find((x) => x.id === first.id).match === "local" && list.find((x) => x.id === first.id).track.title === "Tone One");
await api.patch(`/api/music/saved/${first.id}`, { data: { clear: true } });
list = (await (await api.get("/api/music/saved")).json()).items;
check("a match can be cleared", list.find((x) => x.id === first.id).match === "unmatched");
r = await api.delete("/api/music/saved", { data: { key: "demo artist|alpha track" } });
keys = (await (await api.get("/api/music/saved?keys=1")).json()).keys;
check("un-liking removes it", r.ok() && !keys.includes("demo artist|alpha track"));
// playlist entry the user matches themselves
const pl = await (await api.post("/api/music/playlists", { data: { name: "Match me" } })).json();
await api.post(`/api/music/playlists/${pl.id}/items`, { data: { items: [{ title: "Nonexistent Song", artist: "Nobody", durationSec: 200 }] } });
let pd = await (await api.get(`/api/music/playlists/${pl.id}`)).json();
r = await api.patch(`/api/music/playlists/${pl.id}/items`, { data: { itemId: pd.items[0].id, match: { trackId: lib.find((x) => x.title === "Tone Three").id } } });
pd = await (await api.get(`/api/music/playlists/${pl.id}`)).json();
check("a playlist entry can be matched to a library track by hand", r.ok() && pd.items[0].availability === "local" && pd.items[0].availabilityNote === "Matched by you" && pd.items[0].track.title === "Tone Three", JSON.stringify(pd.items[0]).slice(0, 160));
await api.post(`/api/music/playlists/${pl.id}/check`, { data: { force: true } }); await sleep(1500);
pd = await (await api.get(`/api/music/playlists/${pl.id}`)).json();
check("re-checking sources keeps your manual match", pd.items[0].availability === "local" && pd.items[0].trackId);

// ---- engine auto: a dead Lavalink node makes it fall back to yt-dlp
const cfg = workerCfg({ engine: "auto", lavalink: { nodes: [{ id: "dead", name: "dead", url: "http://127.0.0.1:1", password: "x", searchPrefix: "scsearch" }], allowedSources: ["http"] } });
const W = async (path, body) => (await fetch("http://127.0.0.1:4100" + path, { method: "POST", headers: { Authorization: "Bearer e2e", "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const t0 = Date.now();
const prep = await W("/music/prepare", { cfg, query: { title: "Beta Track", artist: "Demo Artist", durationSec: 10 }, holder: "e2e-auto", role: "current" });
const ready = await until(async () => { const s = (await W("/music/status", { keys: [prep.key] }))[prep.key]; return s?.state === "ready" ? s : s?.state === "failed" ? s : null; }, 40000, 400);
check("auto: with Lavalink down, the song plays through yt-dlp", ready?.state === "ready" && ready.candidate?.engine === "ytdlp", `${JSON.stringify(ready?.candidate)} ${ready?.error ?? ""} in ${Date.now() - t0}ms`);
check("auto: failing over is quick (Lavalink is not retried for every candidate)", Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
await W("/music/release", { holder: "e2e-auto" });
const only = await fetch("http://127.0.0.1:4100/music/search", { method: "POST", headers: { Authorization: "Bearer e2e", "content-type": "application/json" }, body: JSON.stringify({ cfg: { ...cfg, engine: "lavalink" }, q: "alpha track" }) });
check("Lavalink-only reports the node problem instead of silently using yt-dlp", only.status >= 500 || only.status === 503, `${only.status}`);

// ---- UI
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const state = await api.storageState();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(BASE + "/");
check("signed in without an app chosen: / opens the app picker", /\/apps$/.test(page.url()), page.url());
await page.getByRole("heading", { name: /What do you want to do/ }).waitFor();
check("the picker offers Stream and Music", (await page.getByRole("button", { name: /Stream/ }).count()) === 1 && (await page.getByRole("button", { name: /Music/ }).count()) === 1);
await sleep(1000);
await page.screenshot({ path: E + "/shot-apps.png" });
await page.getByRole("button", { name: /Music/ }).click();
await page.waitForURL(/\/music$/);
check("choosing Music opens the music home", /\/music$/.test(page.url()));
await page.getByRole("heading", { name: /Good (morning|afternoon|evening|night)/ }).waitFor();
check("music home has the Spotify-style sidebar (Liked songs, Your Library)", (await page.getByRole("complementary", { name: "Library" }).getByText("Liked songs").count()) >= 1 && (await page.getByText("Your Library").count()) >= 1);
await page.getByRole("heading", { name: "Trending now" }).waitFor({ timeout: 20000 });
check("home shows online shelves (trending, new releases, popular artists)", (await page.getByRole("heading", { name: "New releases" }).count()) === 1 && (await page.getByRole("heading", { name: "Popular artists" }).count()) === 1);
check("the Stream navbar is not shown in the music app", (await page.getByRole("link", { name: "TV Shows" }).count()) === 0);
await page.screenshot({ path: E + "/shot-music-home.png" });
const imgs = await page.$$eval("img", (els) => els.filter((i) => i.src.includes("/api/music/art")).length);
check("remote artwork goes through the local proxy", imgs > 3, `${imgs}`);
const direct = await page.$$eval("img", (els) => els.filter((i) => /localhost:8098|dzcdn/.test(i.src)).length);
check("the browser never loads images from the third-party host directly", direct === 0, `${direct}`);
// play a trending song (resolved by yt-dlp)
await page.getByRole("button", { name: "Play Alpha Track" }).first().click();
const playing = await until(async () => page.evaluate(() => { const a = document.querySelector("audio"); return a && a.currentTime > 0.5 && !a.paused ? a.src : null; }), 45000, 500);
check("clicking a trending song plays it (library first, then on-demand)", !!playing, String(playing));
await page.screenshot({ path: E + "/shot-music-playing.png" });
// heart from the player's row view: open an album page and like a track
await page.goto(BASE + "/music/release/14");
await page.getByRole("heading", { name: "Demo Hits" }).waitFor();
await page.getByRole("button", { name: /Add Beta Track to Liked songs/ }).click({ force: true });
await page.getByRole("button", { name: /Remove Beta Track from Liked songs/ }).waitFor();
await page.goto(BASE + "/music/liked");
await page.getByRole("heading", { name: "Liked songs" }).waitFor();
check("a liked song shows up on the Liked songs page", await page.getByText("Beta Track").first().isVisible());
const unmatched = await (await api.get("/api/music/saved")).json();
check("the like was stored for this profile", unmatched.items.some((x) => x.title === "Beta Track"));
await page.screenshot({ path: E + "/shot-liked.png" });
// artist profile with the expandable info panel
await page.goto(BASE + "/music/artists/Test%20Artist?id=1");
await page.getByRole("heading", { name: "Test Artist", level: 1 }).waitFor();
const about = page.getByRole("complementary", { name: "About Test Artist" });
await about.getByText(/electronic music band/).first().waitFor({ timeout: 15000 });
check("artist page: info panel on the left with the biography", (await about.boundingBox()).x < 400 && (await about.getByText("123K").count()) + (await about.getByText(/fans/).count()) >= 1);
const showMore = about.getByRole("button", { name: "Show more" });
check("artist bio is clamped and expands", (await showMore.count()) === 1);
await showMore.click();
check("…and collapses again", (await about.getByRole("button", { name: "Show less" }).count()) === 1);
await about.getByRole("button", { name: /Similar artists/ }).click();
check("similar artists section expands", (await about.getByRole("link", { name: /Other Artist/ }).count()) === 1);
const w1 = (await about.boundingBox()).width;
await page.getByRole("button", { name: "Collapse artist info" }).click();
await sleep(600);
const w2 = (await about.boundingBox()).width;
check("the whole info panel collapses to a slim rail", w1 > 250 && w2 < 80, `${w1} -> ${w2}`);
await page.getByRole("button", { name: "Expand artist info" }).click();
check("popular songs, discography and library songs are shown", (await page.getByRole("heading", { name: "Popular" }).count()) === 1 && (await page.getByRole("heading", { name: "Discography" }).count()) === 1 && (await page.getByRole("heading", { name: "In your library" }).count()) === 1);
await page.screenshot({ path: E + "/shot-artist.png", fullPage: false });
await page.goto(BASE + "/music/search?q=Alpha%20Track");
check("search also shows catalogue artists/albums/songs", await until(async () => (await page.getByRole("heading", { name: "Songs", exact: true }).count()) > 0, 20000, 400));
// switch app from the menu
await page.getByRole("button", { name: "Account menu" }).click();
await page.getByRole("link", { name: "Switch app" }).last().click();
await page.waitForURL(/\/apps$/);
await page.getByRole("button", { name: /Stream/ }).click();
await page.waitForURL((u) => u.pathname === "/");
check("Stream still works and keeps its own navbar", (await page.getByRole("link", { name: "TV Shows" }).count()) >= 1 && (await page.getByRole("link", { name: "Music", exact: true }).count()) === 0);
// a new browser session (no session cookie) opening the site root is asked again; a direct /music link is not
const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state });
const p2 = await fresh.newPage(); await p2.goto(BASE + "/");
check("opening the site in a fresh browser session asks which app first", /\/apps$/.test(p2.url()), p2.url());
await p2.goto(BASE + "/music");
check("a direct /music link opens Music without asking", /\/music$/.test(p2.url()), p2.url());
await fresh.close();
// mobile: no horizontal overflow, bottom tabs
const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, storageState: state });
const mp = await mob.newPage();
for (const u of ["/music", "/music/artists/Test%20Artist?id=1", "/music/liked", "/music/release/14"]) {
  await mp.goto(BASE + u); await mp.waitForLoadState("networkidle"); await sleep(1200);
  const o = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`mobile ${u.split("?")[0]} has no horizontal overflow`, o.sw <= o.iw, `${o.sw}>${o.iw}`);
}
check("mobile music bottom tabs are shown", (await mp.getByRole("navigation", { name: "Main" }).getByText("Liked").count()) === 1);
await mp.goto(BASE + "/music"); await sleep(1500);
await mp.screenshot({ path: E + "/shot-music-mobile.png" });
check("no uncaught JS errors across pages", errs.filter((e) => !/hydrat|caret/i.test(e)).length === 0, errs.slice(0, 2).join(" | "));
await api.post("/api/music/queue/clear");
await browser.close();
summary();
