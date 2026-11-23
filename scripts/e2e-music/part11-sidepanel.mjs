// Spotify-style "Now playing" column on the right of the Music app: the track, an "About the artist" card (photo, fans,
// bio) and what's next. No lyrics. Collapsible and remembered. Needs the library from part1-local and the fake catalogue.
import { chromium, request, check, until, summary, login, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const lib = await (await api.get("/api/music/library?kind=tracks&take=50")).json();
const by = Object.fromEntries(lib.tracks.map((t) => [t.title, t]));
const item = (t) => ({ trackId: t.id, title: t.title, artist: t.artist, durationSec: t.durationSec ?? 14 });
const order = ["Tone One", "Tone Two", "Legacy Song"].map((t) => item(by[t]));
let r = await api.put("/api/music/queue", { data: { items: order, startIndex: 0 } });
check("queue saved", r.ok(), await r.text().then((t) => t.slice(0, 150)));
const artist = by["Tone One"].artist;

const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const panel = () => page.getByTestId("side-panel");

await page.goto(BASE + "/music");
await page.getByTestId("music-bar").waitFor();
// the saved queue is restored (paused) on load, and the panel shows that song like Spotify does
await panel().waitFor({ timeout: 15000 });
check("panel appears for the restored queue", await panel().isVisible());
await page.getByRole("button", { name: "Play", exact: true }).first().click();
check("shows the track title and artist", (await panel().getByText("Tone One", { exact: true }).count()) >= 1 && (await panel().getByText(artist, { exact: true }).count()) >= 1);

const about = panel().getByRole("region", { name: new RegExp(`About ${artist}`) });
check("artist card is there", (await about.count()) === 1 && (await about.getByText("About the artist").count()) === 1);
const bioOk = await until(async () => (/electronic music band/.test(await about.innerText()) ? true : null), 15000, 200);
check("artist card shows the biography (from the catalogue lookup)", !!bioOk);
check("artist card shows the fan count and a matched badge", (await about.getByText("123K").count()) === 1 && (await about.getByLabel("Matched artist").count()) === 1);
check("artist card links to the artist page", /\/music\/artists\/Test%20Artist\?id=1/.test((await about.getByRole("link").first().getAttribute("href")) ?? ""));
check("artist photo is loaded through the art proxy", (await about.locator("img").first().getAttribute("src"))?.startsWith("/api/music/art?u=") === true);
check("no lyrics section", (await panel().getByText(/lyrics/i).count()) === 0);

const nextCard = panel().getByRole("region", { name: "Next in queue" });
check("next in queue lists the following songs in order", (await nextCard.getByRole("button").allInnerTexts()).map((t) => t.split("\n")[0]).join(",") === "Tone Two,Legacy Song");

// layout: the page content must end where the panel starts, and the panel must not run under the player bar
const card0 = () => panel().locator("> div");   // the visible rounded card (the <aside> itself is just a padded fixed box)
const content = () => page.locator("main > div > div").first();
const pb = await card0().boundingBox();
const main = await content().boundingBox();
const bar = await page.getByTestId("music-bar").boundingBox();
check("page content does not run under the panel", main.x + main.width <= pb.x + 1, `main right=${main.x + main.width} panel left=${pb.x}`);
check("panel stays above the player bar", pb.y + pb.height <= bar.y + 1, `panel bottom=${pb.y + pb.height} bar top=${bar.y}`);
check("panel itself is not wider than the viewport", pb.x + pb.width <= 1440 + 1);

// clicking a queued song in the panel plays it
await nextCard.getByRole("button", { name: "Play Tone Two" }).click();
check("clicking a 'next' song plays it", !!(await until(async () => { const s = await page.evaluate(() => { const a = document.querySelector('[data-testid="music-audio"]'); return a && !a.paused && a.currentTime > 0.3 && a.currentSrc; }); return s && s.includes(`/tracks/${by["Tone Two"].id}/`) ? true : null; }, 20000, 250)));
check("panel title follows the song", !!(await until(async () => ((await panel().getByText("Tone Two", { exact: true }).count()) >= 1 ? true : null), 8000, 200)));

// collapse / remember
await panel().getByRole("button", { name: "Hide now playing view" }).click();
check("hide button collapses the panel", (await panel().count()) === 0);
const full = await content().boundingBox();
check("content takes the space back", full.width > main.width + 200, `${main.width} -> ${full.width}`);
await page.reload();
await page.getByTestId("music-bar").waitFor();
check("collapsed state is remembered", (await panel().count()) === 0);
await page.getByRole("button", { name: "Now playing view" }).click();
check("the bar's toggle brings it back", (await panel().count()) === 1);

// narrow screens: no side column, but the full-screen Now Playing view has the same artist card
await page.setViewportSize({ width: 390, height: 800 });
check("no side panel on a phone-sized screen", !(await panel().isVisible().catch(() => false)));
await page.getByRole("button", { name: "Open now playing" }).click();
const dlg = page.getByRole("dialog", { name: "Now playing" });
await dlg.waitFor();
const card = dlg.getByRole("region", { name: new RegExp(`About ${artist}`) });
check("full-screen Now Playing also shows the artist card", (await card.count()) === 1);
check("…with the biography", !!(await until(async () => (/electronic music band/.test(await card.innerText()) ? true : null), 15000, 200)));
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
check("no horizontal overflow on the phone", sw <= 391, `scrollWidth=${sw}`);
await browser.close();
summary();
