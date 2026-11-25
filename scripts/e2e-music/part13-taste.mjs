// Music setup for a new profile (artists/genres, Spotify step, Android battery step), the taste profile, playlists with
// "Add songs" (search waits 1 s after typing) and "Recommended", the importer page (Android share target) and the
// lookup cache. Needs the library from part1-local and the fake catalogue.
import { chromium, devices, request, check, until, summary, login, sleep, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);

// ---- a brand-new profile goes through the music setup once
let r = await api.post("/api/profiles", { data: { name: "Newbie", avatar: "cat:teal" } });
check("profile created", r.ok(), (await r.text()).slice(0, 120));
const profs = (await (await api.get("/api/profiles")).json()).profiles;
const newbie = profs.find((p) => p.name === "Newbie");
await api.post("/api/profiles/" + newbie.id, { data: {} });

const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));

await page.goto(BASE + "/music");
await page.waitForURL(/\/music\/welcome$/);
check("new profile: /music opens the setup", /\/music\/welcome$/.test(page.url()));
check("setup is full screen (no music sidebar)", (await page.getByRole("complementary", { name: "Library" }).count()) === 0);
await page.getByRole("heading", { name: /What do you listen to, Newbie/ }).waitFor();
await page.getByRole("button", { name: "Test Artist" }).waitFor({ timeout: 15000 });
check("suggests artists from the catalogue", (await page.getByRole("button", { name: "Demo Artist" }).count()) === 1);
check("offers genres", (await page.getByRole("group", { name: "Genres" }).getByRole("button", { name: "Rock" }).count()) === 1);
await page.getByRole("button", { name: "Test Artist" }).click();
await page.getByRole("button", { name: "Demo Artist" }).click();
await page.getByRole("group", { name: "Genres" }).getByRole("button", { name: "Pop" }).click();
check("picks are shown", await page.getByText("2 artists, 1 genre").isVisible());
await page.screenshot({ path: process.env.E + "/shot-welcome.png" });
await page.getByRole("button", { name: "Next", exact: true }).click();
await page.getByRole("heading", { name: "Bring your Spotify playlists" }).waitFor();
check("desktop: 2 steps (no Android battery step)", await page.getByText("2 of 2").isVisible());
await page.getByRole("button", { name: "Done", exact: true }).click();
await page.waitForURL(/\/music$/);
check("finishing lands on the music home", /\/music$/.test(page.url()));
let taste = await (await api.get("/api/music/taste")).json();
check("picks were saved and the profile is set up", taste.onboarded && taste.picks.artists.map((a) => a.name).join() === "Test Artist,Demo Artist" && taste.picks.genres[0]?.name === "Pop", JSON.stringify(taste.picks));
check("picks start the taste profile", taste.artists[0] && ["Test Artist", "Demo Artist"].includes(taste.artists[0].name), JSON.stringify(taste.artists.slice(0, 3)));
await page.goto(BASE + "/music");
check("second visit: no setup again", /\/music$/.test(page.url()));

// ---- Android: an extra step about battery optimisation (Chrome + Rift)
const phone = await browser.newContext({ ...devices["Pixel 7"], storageState: await api.storageState() });
const mp = await phone.newPage();
await mp.goto(BASE + "/music/welcome");
await mp.getByRole("heading", { name: /What do you listen to/ }).waitFor();
check("Android: 3 steps", await mp.getByText("1 of 3").waitFor({ timeout: 5000 }).then(() => true, () => false));
await mp.getByRole("button", { name: /^(Next|Skip)$/ }).click();
await mp.getByRole("heading", { name: "Bring your Spotify playlists" }).waitFor();
await mp.getByRole("button", { name: "Next", exact: true }).click();
await mp.getByRole("heading", { name: "Keep music playing with the screen off" }).waitFor();
check("explains that Chrome needs it too", await mp.getByText(/runs inside Chrome, so Chrome needs the setting/).isVisible());
await mp.getByRole("button", { name: "Samsung" }).click();
check("phone-maker steps (Samsung: never sleeping apps)", await mp.getByText(/Never sleeping apps/).isVisible());
await mp.screenshot({ path: process.env.E + "/shot-welcome-android.png" });
await mp.getByRole("button", { name: "Done", exact: true }).click();
await mp.waitForURL(/\/music$/);
check("battery tip is not shown again on the home after the setup", (await mp.getByText("Music stops when the screen is off?").count()) === 0);
await mp.evaluate(() => localStorage.removeItem("rift-bg-playback-tip"));
await mp.reload();
await mp.getByText("Music stops when the screen is off?").waitFor({ timeout: 10000 });
check("existing Android users get the tip on the home page", true);
await phone.close();

// ---- taste page
await page.goto(BASE + "/music/taste");
await page.getByRole("heading", { name: "Your music taste" }).waitFor();
check("taste page lists artists", (await page.getByRole("link", { name: "Test Artist" }).count()) >= 1);

// ---- playlist: add songs (debounced search) + recommendations
r = await api.post("/api/music/playlists", { data: { name: "Road trip" } });
const pl = await r.json();
await page.goto(BASE + `/music/playlists/${pl.id}`);
await page.getByRole("heading", { name: "Road trip" }).waitFor();
const box = page.getByLabel("Search for songs to add");
check("empty playlist opens the song search", await box.isVisible());
const searches = [];
page.on("request", (q) => { if (/\/api\/music\/(search|online\/search)\?/.test(q.url())) searches.push(Date.now()); });
const typed = Date.now();
await box.pressSequentially("Tone", { delay: 60 });
await sleep(500);
check("no search while typing / right after", searches.length === 0, `${searches.length}`);
await until(() => searches.length > 0, 4000, 50);
check("search starts ~1 s after the last key", searches.length > 0 && searches[0] - typed >= 1000, `${searches[0] - typed} ms`);
const finder = page.getByRole("region", { name: "Find songs for this playlist" });
await finder.getByRole("button", { name: /Add Tone One to this playlist/ }).waitFor({ timeout: 10000 });
await finder.getByRole("button", { name: /Add Tone One to this playlist/ }).click();
await finder.getByRole("button", { name: "Tone One added" }).waitFor();
let pd = await (await api.get(`/api/music/playlists/${pl.id}`)).json();
check("song added to the playlist", pd.items.length === 1 && pd.items[0].title === "Tone One");

const recs = page.getByRole("region", { name: "Recommended songs" });
await recs.waitFor();
check("recommendations under the playlist", await until(async () => (await recs.getByRole("button", { name: /to this playlist$/ }).count()) > 0, 20000, 300));
r = await api.post(`/api/music/playlists/${pl.id}/recommendations`, { data: { shown: [], n: 10 } });
const rj = await r.json();
check("recommendations leave out the playlist's own songs and explain themselves", r.ok() && rj.items.length > 0 && !rj.items.some((x) => x.title === "Tone One") && rj.items.every((x) => typeof x.reason === "string" && x.reason), JSON.stringify(rj.items.slice(0, 3).map((x) => [x.title, x.reason])));
const firstRec = rj.items[0];
const r2 = await (await api.post(`/api/music/playlists/${pl.id}/recommendations`, { data: { shown: rj.items.map((x) => x.key), n: 10 } })).json();
check("refresh skips what was already shown", !r2.items.some((x) => x.key === firstRec.key));
await page.screenshot({ path: process.env.E + "/shot-playlist-recs.png", fullPage: true });
await page.getByRole("button", { name: "Add songs" }).click();
check("“Add songs” opens/focuses the search", await until(() => box.evaluate((el) => document.activeElement === el), 3000, 100));

// ---- importer page as Android share target (text from the Spotify app's Share button)
await page.goto(BASE + "/music/import?text=" + encodeURIComponent("Check this out https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M"));
await page.getByRole("heading", { name: "Import from Spotify" }).waitFor();
check("shared link is filled in and checked", await page.getByText(/That's a song link/).waitFor({ timeout: 15000 }).then(() => true, () => false));

// ---- app picker (plain)
await page.goto(BASE + "/apps");
await page.getByRole("heading", { name: /What do you want to do/ }).waitFor();
check("app picker offers both apps", (await page.getByRole("button", { name: /Stream/ }).count()) === 1 && (await page.getByRole("button", { name: /Music/ }).count()) === 1);

// ---- cache: the same catalogue lookups aren't repeated
const stats0 = await (await fetch("http://localhost:8098/__stats")).json();
await api.post(`/api/music/playlists/${pl.id}/recommendations`, { data: { shown: [], n: 10 } });
const stats1 = await (await fetch("http://localhost:8098/__stats")).json();
const delta = Object.keys(stats1).filter((k) => /^\/(artist|chart|search)/.test(k)).reduce((s, k) => s + (stats1[k] - (stats0[k] ?? 0)), 0);
check("repeat recommendations come from the cache (no new catalogue requests)", delta === 0, `${delta} new requests`);

check("no uncaught JS errors", errs.filter((e) => !/hydrat|caret/i.test(e)).length === 0, errs.slice(0, 2).join(" | "));
// back to the main profile for later parts
await api.post("/api/profiles/" + profs[0].id, { data: {} });
await browser.close();
summary();
