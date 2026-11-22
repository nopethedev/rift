// Mobile audit: every main page on phone-sized touch devices. Fails on horizontal overflow, and reports (or fails on) tiny tap
// targets. Screenshots go to $E/m-*.png. Stream pages use the fake TMDB served by fake-catalog.mjs.
import { chromium, devices, request, check, sleep, summary, login, BASE, E } from "./lib.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const STRICT = process.env.MOBILE_STRICT === "1";
const api = await request.newContext({ baseURL: BASE });
await login(api);
await api.put("/api/admin/settings", { data: { tmdbApiKey: "fake-key" } });
await api.put("/api/admin/music/settings", { data: { musicSource: "hybrid", musicEngine: "auto", musicMetadata: true, musicRightsAttested: true, musicLicensePolicy: "attested", musicSearchProviders: ["soundcloud"] } });
const state = await api.storageState();
const cover = fs.readFileSync(E + "/fake-cover.jpg");

const PAGES = [
  ["/apps", "apps"], ["/", "home"], ["/browse/movies", "movies"], ["/browse/tv", "tv"], ["/search?q=sample", "search"], ["/my-list", "mylist"],
  ["/title/movie/1003", "title-movie"], ["/title/tv/1004", "title-tv"],
  ["/music", "m-home"], ["/music/search?q=alpha", "m-search"], ["/music/library", "m-library"], ["/music/liked", "m-liked"], ["/music/playlists", "m-playlists"],
  ["/music/artists/Test%20Artist?id=1", "m-artist"], ["/music/release/14", "m-release"], ["/music/genre/132", "m-genre"],
  ["/profiles", "profiles"], ["/admin", "admin"], ["/admin/media", "admin-media"], ["/admin/music", "admin-music"], ["/admin/music/settings", "admin-music-settings"], ["/admin/settings", "admin-settings"], ["/admin/users", "admin-users"], ["/admin/streams", "admin-streams"], ["/admin/storage", "admin-storage"],
];
const DEVICES = { "iPhone13": devices["iPhone 13"], "small-android": { ...devices["Pixel 5"], viewport: { width: 360, height: 640 } } };

const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const report = [];
for (const [dname, dev] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...dev, storageState: state });
  await ctx.route("https://image.tmdb.org/**", (r) => r.fulfill({ contentType: "image/jpeg", body: cover }));
  await ctx.addCookies([{ name: "rift_app", value: "stream", url: BASE }]);
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  for (const [url, name] of PAGES) {
    await page.goto(BASE + url, { waitUntil: "load" }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(700);
    const m = await page.evaluate(() => {
      const iw = window.innerWidth;
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05 && r.bottom > 0 && r.right > 0 && r.left < iw; };
      const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.getAttribute("title") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
      const small = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], summary")].filter((el) => !el.closest(".sr-only") && vis(el) && !el.disabled).map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), label: label(el), w: Math.round(r.width), h: Math.round(r.height), type: el.type }; })
        .filter((x) => x.type !== "range" && x.type !== "checkbox" && x.type !== "radio" && Math.min(x.w, x.h) < 36 && !(x.tag === "a" && x.h >= 30 && x.w >= 60));
      const wide = [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > iw + 1 && r.width > 0 && !el.closest("[class*=overflow-x]") && getComputedStyle(el).position !== "fixed"; }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
      const tiny = [...document.querySelectorAll("p, span, a, button, label, li, td, h1, h2, h3")].filter((el) => el.children.length === 0 && el.textContent.trim() && vis(el) && parseFloat(getComputedStyle(el).fontSize) < 11).length;
      const scrolled = [...document.querySelectorAll("div")].filter((el) => el.scrollWidth > el.clientWidth + 4 && /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollLeft > 2).length;
      return { sw: document.documentElement.scrollWidth, iw, small, wide, tiny, scrolled, title: document.title };
    });
    const ok = m.sw <= m.iw;
    check(`${dname} ${name}: no horizontal overflow`, ok, ok ? "" : `${m.sw}>${m.iw} ${m.wide.join(", ")}`);
    check(`${dname} ${name}: horizontal shelves start at the left edge`, m.scrolled === 0, `${m.scrolled} scrolled`);
    if (m.small.length) report.push({ dname, name, small: m.small });
    if (m.tiny) report.push({ dname, name, tinyText: m.tiny });
    if (dname === "iPhone13") await page.screenshot({ path: `${E}/m-${name}.png` });
  }
  check(`${dname}: no uncaught JS errors`, errs.filter((e) => !/hydrat|caret/i.test(e)).length === 0, errs.slice(0, 2).join(" | "));
  await ctx.close();
}

// ---- PWA basics
const anon = await request.newContext({ baseURL: BASE });
const mf = await anon.get("/manifest.webmanifest");
const man = await mf.json().catch(() => ({}));
check("web app manifest is served (name, standalone, start_url, 192/512 + maskable icons)", mf.ok() && man.name === "Rift" && man.display === "standalone" && man.start_url === "/" && ["192x192", "512x512"].every((z) => man.icons?.some((i) => i.sizes === z)) && man.icons.some((i) => i.purpose === "maskable"), JSON.stringify(man).slice(0, 120));
for (const i of man.icons ?? []) check(`manifest icon ${i.src} is a PNG`, (await anon.get(i.src)).headers()["content-type"] === "image/png");
const sw = await anon.get("/sw.js");
check("service worker script is served without a login", sw.ok() && /javascript/.test(sw.headers()["content-type"] ?? ""));
const html = await (await anon.get("/login")).text();
check("pages declare viewport-fit=cover, theme colour, manifest and an apple touch icon", /viewport-fit=cover/.test(html) && /name="theme-color"/.test(html) && /rel="manifest"/.test(html) && /rel="apple-touch-icon"/.test(html) && /mobile-web-app-capable/.test(html), JSON.stringify({ vp: /viewport-fit=cover/.test(html), theme: /name="theme-color"/.test(html), manifest: /rel="manifest"/.test(html), apple: /rel="apple-touch-icon"/.test(html), cap: /mobile-web-app-capable/.test(html) }));

// ---- the video player on a phone
await api.put("/api/admin/settings", { data: { whisperAuto: false } });
fs.mkdirSync(E + "/media/Phone Film (2022)", { recursive: true });
const film = E + "/media/Phone Film (2022)/Phone Film (2022).webm";
if (!fs.existsSync(film)) spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:d=60:r=10", "-f", "lavfi", "-i", "sine=frequency=330:duration=60", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "150k", "-c:a", "libopus", film]);
await api.post("/api/admin/media/scan");
let fileId = null;
for (let i = 0; i < 60 && !fileId; i++) {
  const j = await (await api.get("/api/admin/media")).json();
  fileId = j.unmatched.find((x) => x.path.includes("Phone Film"))?.id ?? null;
  if (!fileId) { for (const t of j.titles) { const d = await (await api.get(`/api/admin/media/title/${t.id}`)).json(); const f = [...(d.files ?? []), ...(d.episodes ?? []).flatMap((e) => e.files)].find((x) => x.path.includes("Phone Film")); if (f) fileId = f.id; } }
  if (!fileId) await sleep(1000);
}
check("test film imported", !!fileId);
for (const [dname, dev] of [["iPhone13 portrait", devices["iPhone 13"]], ["iPhone13 landscape", devices["iPhone 13 landscape"]]]) {
  const ctx = await browser.newContext({ ...dev, storageState: state });
  const page = await ctx.newPage();
  await page.goto(BASE + `/watch/${fileId}`);
  await page.locator("video").waitFor();
  await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; });
  const start = await until2(() => page.evaluate(() => document.querySelector("video").readyState >= 3), 30000);
  check(`${dname}: player loads`, start);
  const vp = page.viewportSize();
  const box = async (sel) => (await page.locator(sel).first().boundingBox());
  // controls visible at start (paused or just started): the touch cluster has the big play/pause + 10 s buttons
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));
  await sleep(300);
  await page.touchscreen.tap(vp.width / 2, vp.height / 2 - 100); // tap the video: show controls
  await sleep(450);
  const cluster = await page.getByRole("button", { name: /^(Pause|Play)$/ }).first().boundingBox();
  check(`${dname}: touch controls show a large play/pause button`, !!cluster && cluster.width >= 56, JSON.stringify(cluster));
  const bar = await page.getByRole("button", { name: "Fullscreen" }).boundingBox();
  check(`${dname}: bottom-bar buttons are finger sized (>= 40 px)`, !!bar && bar.width >= 40 && bar.height >= 40, JSON.stringify(bar));
  const seekH = await page.locator('input[aria-label="Seek"]').boundingBox();
  check(`${dname}: seek bar has a tall touch area`, !!seekH && seekH.height >= 32, JSON.stringify(seekH));
  check(`${dname}: no duplicate small play/skip buttons in the bottom bar on touch`, (await page.getByRole("button", { name: "Back 10 seconds" }).count()) === 1);
  // a single tap toggles the controls (state alternates visible / hidden / visible)
  const vis = async () => (await page.getByRole("button", { name: "Fullscreen" }).count()) === 1;
  await page.evaluate(() => document.querySelector("video").play().catch(() => {}));
  await page.touchscreen.tap(vp.width / 2, vp.height / 3); await sleep(750);
  const s1 = await vis();
  await page.touchscreen.tap(vp.width / 2, vp.height / 3); await sleep(750);
  const s2 = await vis();
  await page.touchscreen.tap(vp.width / 2, vp.height / 3); await sleep(750);
  const s3 = await vis();
  check(`${dname}: tapping the video toggles the controls`, s1 !== s2 && s2 !== s3, `${s1} ${s2} ${s3}`);
  // double tap seeks
  await page.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 20; });
  await sleep(300);
  const t0 = await page.evaluate(() => document.querySelector("video").currentTime);
  const y = vp.height / 3;
  await page.touchscreen.tap(vp.width * 0.85, y); await sleep(90); await page.touchscreen.tap(vp.width * 0.85, y);
  await sleep(500);
  const t1 = await page.evaluate(() => document.querySelector("video").currentTime);
  check(`${dname}: double tap on the right side skips forward 10 s`, t1 - t0 > 8 && t1 - t0 < 14, `${t0.toFixed(1)} -> ${t1.toFixed(1)}`);
  await page.touchscreen.tap(vp.width * 0.15, y); await sleep(90); await page.touchscreen.tap(vp.width * 0.15, y);
  await sleep(500);
  const t2 = await page.evaluate(() => document.querySelector("video").currentTime);
  check(`${dname}: double tap on the left side goes back 10 s`, t1 - t2 > 7, `${t1.toFixed(1)} -> ${t2.toFixed(1)}`);
  // menus are sheets that stay on screen
  if ((await page.getByRole("button", { name: "Fullscreen" }).count()) === 0) await page.touchscreen.tap(vp.width / 2, y);
  await sleep(500);
  for (const name of ["Subtitles", "Audio", "Playback speed"]) {
    await page.getByRole("button", { name, exact: true }).tap();
    await sleep(350);
    const menu = await page.locator("div.glass.fixed, div.glass").filter({ hasText: name.toUpperCase() === name ? name : "" }).last().boundingBox().catch(() => null);
    const pop = await page.evaluate(() => { const m = [...document.querySelectorAll("div")].filter((d) => /max-h-\[55dvh\]|overflow-y-auto/.test(d.className) && d.className.includes("glass")).pop(); if (!m) return null; const r = m.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
    check(`${dname}: the ${name} menu fits on screen`, !!pop && pop.l >= 0 && pop.r <= vp.width && pop.t >= 0 && pop.b <= vp.height, JSON.stringify(pop));
    await page.getByRole("button", { name, exact: true }).tap().catch(() => {});
    await sleep(200);
  }
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  check(`${dname}: player page has no horizontal overflow`, o.sw <= o.iw);
  await page.screenshot({ path: `${E}/m-player-${dname.includes("land") ? "land" : "port"}.png` });
  await ctx.close();
}
async function until2(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(250); } return false; }
const small = report.filter((r) => r.small);
console.log("\n--- tap targets under 36px (first device, deduplicated) ---");
const seen = new Set();
for (const r of report.filter((x) => x.dname === "iPhone13" && x.small)) for (const s of r.small) { const k = `${s.tag}|${s.label}`; if (seen.has(k)) continue; seen.add(k); console.log(`${r.name.padEnd(22)} ${s.tag.padEnd(7)} ${String(s.w).padStart(3)}x${String(s.h).padEnd(3)} ${s.label}`); }
console.log("tiny text (<11px) elements:", report.filter((x) => x.dname === "iPhone13" && x.tinyText).map((x) => `${x.name}:${x.tinyText}`).join(", ") || "none");
if (STRICT) check("no tap target under 36px", small.length === 0, `${seen.size} distinct offenders`);
await browser.close();
summary();
