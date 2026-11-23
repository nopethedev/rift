// The home hero must keep its text inside itself: even a long title + long overview must stay clear of the fixed navbar
// and of the strip at the bottom that the first row is pulled up over (it used to run into "Recently Added to Your Library").
// The text is replaced in the live DOM because the fake TMDB's titles are short. Screenshots go to $E/hero-*.png.
import { chromium, request, check, sleep, summary, login, BASE, E } from "./lib.mjs";
import fs from "node:fs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
await api.put("/api/admin/settings", { data: { tmdbApiKey: "fake-key" } });
await sleep(3500); // the settings cache lives 3s; the page must not render before it sees the key
const state = await api.storageState();
const cover = fs.readFileSync(E + "/fake-cover.jpg");
const TITLE = "The Hunger Games: Sunrise on the Reaping";
const OVERVIEW = "Return to the world of Panem 24 years before Katniss Everdeen volunteers in her sister's place, commencing on the morning of the reaping of the 50th Hunger Games, also known as the Second Quarter Quell.";

const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const SIZES = [["phone", 390, 800], ["small phone", 360, 640], ["tablet", 820, 1100], ["laptop", 1366, 700], ["short laptop", 1280, 620], ["desktop", 1920, 1080]];
for (const [name, width, height] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height }, storageState: state });
  await ctx.route("https://image.tmdb.org/**", (r) => r.fulfill({ contentType: "image/jpeg", body: cover }));
  await ctx.addCookies([{ name: "rift_app", value: "stream", url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.locator("header h1").first().waitFor({ timeout: 20000 }).catch(async (e) => { await page.screenshot({ path: `${E}/hero-fail.png` }); console.log("URL", page.url(), "\n", (await page.locator("body").innerText()).slice(0, 400)); throw e; });
  await page.locator("header").first().hover(); // pauses the rotation
  await sleep(1200);
  const m = await page.evaluate(([t, o]) => {
    const hero = document.querySelector("header");
    const h1 = hero.querySelector("h1");
    h1.textContent = t;
    const p = hero.querySelector("p.line-clamp-3");
    if (p) p.textContent = o;
    const block = h1.parentElement;
    const hb = hero.getBoundingClientRect(), bb = block.getBoundingClientRect();
    const row = [...document.querySelectorAll("section, h2")].find((e) => e.getBoundingClientRect().top > hb.top + 50 && e.getBoundingClientRect().top < hb.bottom + 400 && !hero.contains(e));
    const rowTop = row ? row.getBoundingClientRect().top : hb.bottom;
    const nav = document.querySelector("nav,header ~ header, [data-navbar]");
    const lines = Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight));
    return { heroTop: hb.top + scrollY, heroBottom: hb.bottom + scrollY, blockTop: bb.top + scrollY, blockBottom: bb.bottom + scrollY, rowTop: rowTop + scrollY, lines, overflowX: document.documentElement.scrollWidth - innerWidth, h1Right: h1.getBoundingClientRect().right, innerWidth, navH: 64 };
  }, [TITLE, OVERVIEW]);
  await sleep(300);
  await page.screenshot({ path: `${E}/hero-${name.replace(/ /g, "-")}.png` });
  check(`${name} ${width}x${height}: hero text ends above the first row`, m.blockBottom <= m.rowTop - 4, `text bottom=${Math.round(m.blockBottom)} row top=${Math.round(m.rowTop)}`);
  check(`${name}: hero text stays inside the hero and below the navbar`, m.blockTop >= m.heroTop + 56 && m.blockBottom <= m.heroBottom, `block ${Math.round(m.blockTop)}–${Math.round(m.blockBottom)} hero ${Math.round(m.heroTop)}–${Math.round(m.heroBottom)}`);
  check(`${name}: long title clamps to <= 3 lines and fits the width`, m.lines <= 3 && m.h1Right <= m.innerWidth, `lines=${m.lines}`);
  check(`${name}: no horizontal overflow`, m.overflowX <= 0, `+${m.overflowX}`);
  await ctx.close();
}
await browser.close();
summary();
