// Discord Rich Presence: per-profile token, the player's heartbeat, the snapshot the companion reads, and the real
// companion script (--dry-run: no Discord needed). Needs the library from part1-local.
import { spawn } from "node:child_process";
import { chromium, request, check, until, summary, login, BASE } from "./lib.mjs";
const api = await request.newContext({ baseURL: BASE });
await login(api);
const j = async (r) => ({ status: r.status(), body: await r.json().catch(() => null) });

let r = await j(await api.put("/api/admin/settings", { data: { discordClientId: "abc" } }));
check("admin: a non-numeric Application ID is rejected", r.status === 400);
r = await j(await api.put("/api/admin/settings", { data: { discordClientId: "123456789012345678" } }));
check("admin: Application ID saved", r.status === 200 && r.body.settings.discordClientId === "123456789012345678");

let st = (await j(await api.get("/api/presence/settings"))).body;
check("presence starts switched off (no token), music on / stream off by default", st.available && st.token === null && st.music === true && st.stream === false, JSON.stringify(st));
const none = await api.post("/api/music/presence", { data: { itemId: null, position: 0, playing: false } });
check("player heartbeat is ignored while presence is off", (await none.json()).enabled === false);

st = (await j(await api.post("/api/presence/settings"))).body;
const token = st.token;
check("creating a link gives a secret token", /^rp_[A-Za-z0-9_-]{30,}$/.test(token ?? ""), token);
const noAuth = await request.newContext({ baseURL: BASE }); // the companion has no session
let s1 = await j(await noAuth.get(`/api/presence/${token}`));
check("companion can read the snapshot with the token alone", s1.status === 200 && s1.body.clientId === "123456789012345678" && s1.body.activity === null, JSON.stringify(s1.body));
check("a wrong or malformed token is a 404", (await noAuth.get("/api/presence/rp_" + "x".repeat(32))).status() === 404 && (await noAuth.get("/api/presence/nope")).status() === 404);
check("the session-only API is not open to anonymous users", (await noAuth.get("/api/presence/settings")).status() === 401 || (await noAuth.get("/api/presence/settings")).status() === 404);

// the real player reports what it plays
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await api.storageState() });
const page = await ctx.newPage();
await page.goto(BASE + "/music/library");
await page.getByRole("link", { name: /Test Album/ }).first().click();
await page.getByRole("heading", { name: "Test Album" }).waitFor();
await page.getByRole("button", { name: "Play Tone One" }).click();
const act = await until(async () => { const x = await j(await noAuth.get(`/api/presence/${token}`)); return x.body?.activity ?? null; }, 20000, 400);
check("playing a song shows up as 'Listening' with title and artist", act && act.type === 2 && act.details === "Tone One" && act.state === "by Test Artist", JSON.stringify(act));
check("progress timeline is present (start before now, end = start + length)", act?.timestamps && act.timestamps.start <= Date.now() && Math.abs((act.timestamps.end - act.timestamps.start) / 1000 - 14) < 1.5, JSON.stringify(act?.timestamps));
check("a private library cover is never sent to Discord (it cannot reach this server)", !act?.assets?.large_image && act?.assets?.large_text === "Test Album", JSON.stringify(act?.assets));
st = (await j(await api.get("/api/presence/settings"))).body;
check("the website sees the companion's last poll and what is shown", !!st.companionSeenAt && st.showing?.details === "Tone One", JSON.stringify(st).slice(0, 200));

// the real companion script, dry run
const out = [];
const child = spawn(process.execPath, ["public/rift-discord-presence.mjs", "--server", BASE, "--token", token, "--dry-run", "--poll", "2"], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => out.push(String(d)));
child.stderr.on("data", (d) => out.push(String(d)));
process.on("exit", () => child.kill());
check("companion script prints what it would show", !!(await until(() => out.join("").includes("would show: Listening to Tone One - by Test Artist"), 15000, 300)), out.join("").slice(0, 200));

await page.evaluate(() => document.querySelector('[data-testid="music-audio"]').pause());
const paused = await until(async () => { const x = await j(await noAuth.get(`/api/presence/${token}`)); return /paused/.test(x.body?.activity?.state ?? "") ? x.body.activity : null; }, 10000, 300);
check("pausing updates the status (paused, no timeline)", paused && !paused.timestamps, JSON.stringify(paused));

// switches
await api.put("/api/presence/settings", { data: { music: false } });
s1 = await j(await noAuth.get(`/api/presence/${token}`));
check("music switched off: nothing shown", s1.body.activity === null);
check("music switched off: the player heartbeat is ignored", (await (await api.post("/api/music/presence", { data: { itemId: null, position: 0, playing: false } })).json()).enabled === false);
await api.put("/api/presence/settings", { data: { music: true } });

// UI page
await page.goto(BASE + "/discord");
await page.getByRole("heading", { name: "Discord presence" }).waitFor();
check("settings page shows the command with the server and token", (await page.locator("code").first().innerText()).includes(`--token ${token}`));
await page.screenshot({ path: process.env.E + "/shot-discord.png" });

// regenerate + revoke
const old = token;
st = (await j(await api.post("/api/presence/settings"))).body;
check("a new link invalidates the old one", st.token !== old && (await noAuth.get(`/api/presence/${old}`)).status() === 404 && (await noAuth.get(`/api/presence/${st.token}`)).status() === 200);
await j(await api.delete("/api/presence/settings"));
check("turning it off revokes the token", (await noAuth.get(`/api/presence/${st.token}`)).status() === 404 && (await j(await api.get("/api/presence/settings"))).body.token === null);
check("the companion exits when its token is revoked", !!(await until(() => out.join("").includes("revoked"), 15000, 300)), out.join("").slice(-200));
child.kill();
summary();
