// Drives the whole stack (Next.js + worker + headless Chromium). Playwright is not a project dependency:
// set PLAYWRIGHT_RESOLVE_FROM to a directory (with trailing slash) whose node_modules has it, or install it globally.
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_RESOLVE_FROM || import.meta.url);
export const { chromium, request, devices } = require("playwright");
export const BASE = "http://localhost:3100";
export const WORKER = "http://127.0.0.1:4100";
export const E = process.env.E;
export const results = [];
export function check(name, ok, detail = "") { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); return !!ok; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 15000, step = 200) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) return false; await sleep(step); } }
export function summary() { const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length}/${results.length} passed`); if (bad.length) { console.log("FAILED:", bad.map((b) => b.name).join("; ")); process.exitCode = 1; } }
export async function login(ctx) {
  // first run: setup; later runs: login
  const setup = await ctx.post(BASE + "/api/setup", { data: { username: "admin", password: "Sup3r-secret-pass!", libraryDirs: [E + "/media"], downloadDir: E + "/media/downloads" } });
  if (!setup.ok()) { const l = await ctx.post(BASE + "/api/auth/login", { data: { username: "admin", password: "Sup3r-secret-pass!" } }); if (!l.ok()) throw new Error("login failed " + (await l.text())); }
  const profs = await (await ctx.get(BASE + "/api/profiles")).json();
  const sel = await ctx.post(BASE + "/api/profiles/" + profs.profiles[0].id, { data: {} });
  await ctx.put(BASE + "/api/music/taste", { data: { onboarded: true } }); // skip the music setup (part13 tests it)
  if (!sel.ok()) throw new Error("select profile failed " + (await sel.text()));
  return profs.profiles[0].id;
}
export const workerCfg = (over = {}) => ({ engine: "ytdlp", cacheDir: "", maxCacheMB: 512, cleanup: true, cleanupGraceSec: 2, format: "mp3", bitrateKbps: 192, maxDownloads: 2, maxStreams: 0, licensePolicy: "attested", ytdlp: { providers: ["soundcloud"], binary: "" }, lavalink: { nodes: [], allowedSources: [] }, ...over });
export async function workerStats(cfg = workerCfg()) { const r = await fetch(WORKER + "/music/stats", { method: "POST", headers: { Authorization: "Bearer e2e", "content-type": "application/json" }, body: JSON.stringify({ cfg }) }); return r.json(); }
