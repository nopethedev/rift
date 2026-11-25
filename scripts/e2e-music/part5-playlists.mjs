import { chromium, request, check, until, sleep, summary, login, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
await api.put("/api/admin/music/settings", { data: { musicSource: "hybrid", musicEngine: "ytdlp", musicRightsAttested: true, musicLicensePolicy: "attested", musicSearchProviders: ["soundcloud"], musicPreload: false, musicCleanupGraceSec: 2 } });

// ---- Spotify import edge cases (Spotify itself is unreachable from the test environment)
let r = await api.post("/api/music/playlists/import", { data: { url: "https://example.com/not-spotify" } });
check("import rejects non-Spotify links", r.status() === 400 && /Spotify/i.test((await r.json()).error), `${r.status()}`);
r = await api.post("/api/music/playlists/import", { data: { url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" } });
const j = await r.json();
check("unreachable Spotify gives a readable error (not a crash)", r.status() === 502 && /Could not reach Spotify|Spotify/i.test(j.error), `${r.status()} ${j.error}`);

// ---- playlists: manual, with local + on-demand + unavailable items, availability check, play
const pl = await (await api.post("/api/music/playlists", { data: { name: "Mixed bag" } })).json();
const lib = await (await api.get("/api/music/library?kind=tracks&take=50")).json();
const tone1 = lib.tracks.find((t) => t.title === "Tone One");
await api.post(`/api/music/playlists/${pl.id}/items`, { data: { items: [{ trackId: tone1.id }, { title: "Alpha Track", artist: "Demo Artist", durationSec: 10 }, { title: "Beta Track", artist: "Demo Artist", durationSec: 10 }, { title: "Nonexistent Song", artist: "Nobody", durationSec: 200 }] } });
r = await api.post(`/api/music/playlists/${pl.id}/check`);
check("availability check starts in the background", r.ok());
const done = await until(async () => { const c = await (await api.get(`/api/music/playlists/${pl.id}/check`)).json(); return !c.running ? c : null; }, 60000, 500);
const detail = await (await api.get(`/api/music/playlists/${pl.id}`)).json();
const av = Object.fromEntries(detail.items.map((i) => [i.title, i.availability]));
check("library track marked local", av["Tone One"] === "local", JSON.stringify(av));
check("found-on-source tracks marked on-demand", av["Alpha Track"] === "ondemand" && av["Beta Track"] === "ondemand", JSON.stringify(av));
const nonex = detail.items.find((i) => i.title === "Nonexistent Song");
check("tracks nobody has are marked unavailable with a reason", nonex.availability === "unavailable" && /No source|authorised source|matched closely|No recording/i.test(nonex.availabilityNote ?? ""), nonex.availabilityNote);
check("playlist summary counts unavailable", detail.playlist.unavailable === 1 && detail.playlist.count === 4);
// covers for entries that came without one are looked up automatically (Deezer, then iTunes)
{
  const arted = await until(async () => { const d = await (await api.get(`/api/music/playlists/${pl.id}`)).json(); const a = d.items.find((i) => i.title === "Alpha Track"); return a?.artworkUrl ? d : null; }, 30000, 500);
  const alpha = arted?.items.find((i) => i.title === "Alpha Track");
  check("playlist songs without a cover get one automatically", /cover-14\.jpg$/.test(alpha?.artworkUrl ?? ""), alpha?.artworkUrl ?? "none");
  const missing = arted?.items.find((i) => i.title === "Nonexistent Song");
  check("a song nobody has art for stays without (and is not retried on every view)", !missing?.artworkUrl, missing?.artworkUrl ?? "");
  const lists = await (await api.get("/api/music/playlists")).json();
  const mine = (lists.playlists ?? lists).find((x) => x.id === pl.id);
  check("playlist list shows a cover taken from its songs", !!mine?.artworkUrl, mine?.artworkUrl ?? "none");
}
r = await api.post(`/api/music/playlists/${pl.id}/sync`);
check("manual playlists cannot be 'synced'", r.status() === 400);
r = await api.post(`/api/music/playlists/${pl.id}/play`, { data: {} });
const q = await r.json();
check("playing a playlist queues only playable tracks (skips unavailable)", r.ok() && q.items.length === 3 && !q.items.some((i) => i.title === "Nonexistent Song"), `n=${q.items?.length}`);
const pinned = q.items.find((i) => i.title === "Alpha Track");
check("on-demand entries keep the matched source pinned (signed)", pinned?.candidate?.sourceId === "soundcloud:alpha" && !!pinned.candidate.sig, JSON.stringify(pinned?.candidate)?.slice(0, 120));
// hybrid: an item added by name that exists in the library plays from the library
await api.put("/api/music/queue", { data: { items: [{ title: "Tone Two", artist: "Test Artist", durationSec: 14 }], startIndex: 0 } });
const pr = await (await api.post("/api/music/play", { data: {} })).json();
check("hybrid mode prefers the library for a song that exists locally", pr.play?.kind === "local", pr.play?.kind);

// ---- UI render checks (no JS errors, key elements)
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(BASE + `/music/playlists/${pl.id}`);
await page.getByRole("heading", { name: "Mixed bag" }).waitFor();
check("playlist page shows unavailable entries clearly", (await page.getByText(/unavailable|No authorised source|matched closely/i).first().isVisible()));
await page.screenshot({ path: process.env.E + "/shot-playlist.png" });
await page.goto(BASE + "/music/playlists");
await page.getByRole("button", { name: "Import from Spotify" }).click();
await page.getByLabel("Spotify links").fill("Listen on Spotify: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
await page.getByRole("button", { name: "Continue", exact: true }).click();
await page.getByRole("button", { name: "Import", exact: true }).click();
check("Spotify import dialog shows the failure inline", await page.getByText(/Failed/).first().waitFor({ timeout: 30000 }).then(() => true, () => false));
await page.goto(BASE + "/music/search?q=Alpha%20Track");
await page.getByText("On-demand").first().waitFor();
check("search page shows library + on-demand sections", await until(async () => (await page.getByRole("button", { name: /Play Alpha Track/ }).count()) > 0, 30000, 500));
await page.screenshot({ path: process.env.E + "/shot-search.png" });
for (const u of ["/admin/music", "/admin/music/settings", "/music"]) {
  await page.goto(BASE + u); await page.waitForLoadState("networkidle"); await sleep(800);
  await page.screenshot({ path: process.env.E + "/shot-" + u.replaceAll("/", "_") + ".png" });
}
check("no uncaught JS errors across pages", errs.filter((e) => !/hydrat|caret/i.test(e)).length === 0, errs.slice(0, 2).join(" | "));
await api.post("/api/music/queue/clear");
await browser.close();
summary();
