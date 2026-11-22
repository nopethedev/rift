// Automatic subtitles with the REAL Whisper-tiny model: library file with speech -> worker job -> progressive VTT -> player.
// Needs WHISPER_MODEL_DIR (folder containing Xenova/whisper-tiny) because the test environment cannot reach Hugging Face.
import { chromium, request, check, until, sleep, summary, login, BASE, E } from "./lib.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const jfk = path.join(here, "../../worker/whisper/fixtures/jfk.wav");
const api = await request.newContext({ baseURL: BASE });
await login(api);
const put = (data) => api.put("/api/admin/settings", { data });

// ---- fixtures: two identical films with speech (5 s silence, the JFK clip, 4 s silence), VP9 + Opus so Chromium plays them directly
for (const name of ["Speech Movie (2020)", "Quiet Night (2021)"]) {
  const dir = path.join(E, "media", name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.webm`);
  if (fs.existsSync(out)) continue;
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x202040:s=160x90:d=20:r=10", "-f", "lavfi", "-t", "5", "-i", "anullsrc=r=48000:cl=mono", "-i", jfk, "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=48000:cl=mono",
    "-filter_complex", "[1:a]aresample=48000[a1];[2:a]aresample=48000[a2];[3:a]aresample=48000[a3];[a1][a2][a3]concat=n=3:v=0:a=1[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "100k", "-c:a", "libopus", "-shortest", out]);
  if (r.status !== 0) throw new Error("fixture: " + r.stderr);
}
await put({ whisperEnabled: true, whisperAuto: true, whisperModel: "Xenova/whisper-tiny", whisperLanguage: "auto", whisperTranslate: false, whisperAccess: "everyone" });
let r = await api.post("/api/admin/media/scan"); // (the boot-time scan may already be running: that is fine)
const files = await until(async () => {
  const j = await (await api.get("/api/admin/media")).json();
  const all = [...j.unmatched]; // without TMDB the films stay "unmatched": still playable
  for (const t of j.titles) { const d = await (await api.get(`/api/admin/media/title/${t.id}`)).json(); all.push(...(d.files ?? []), ...(d.episodes ?? []).flatMap((e) => e.files)); }
  const f = (n) => all.find((x) => (x.path ?? "").includes(n));
  return f("Speech Movie") && f("Quiet Night") ? { speech: f("Speech Movie"), quiet: f("Quiet Night") } : null;
}, 60000, 1000);
check("both films were imported", !!files);
if (!files) { summary(); process.exit(1); }

// ---- worker side
const st = await (await api.get("/api/admin/subtitles/ai")).json();
check("worker reports the speech engine installed", st.installed === true, JSON.stringify(st));

// ---- auto: loading the player info of a film with no subtitles starts the job
let info = await (await api.get(`/api/media/${files.speech.id}/info`)).json();
check("a film without subtitles gets an AI track on first play", info.subtitles.length === 1 && info.subtitles[0].auto === true, JSON.stringify(info.subtitles));
check("AI generation is offered/available in the player info", info.ai?.available === true && info.ai.mayStart === false, JSON.stringify(info.ai));
const subId = info.subtitles[0].id;
const ready = await until(async () => { const i = await (await api.get(`/api/media/${files.speech.id}/info`)).json(); return i.subtitles[0].status === "ready" ? i.subtitles[0] : null; }, 120000, 1000);
check("the job finishes (real Whisper tiny on the worker's CPU)", !!ready, JSON.stringify(ready));
check("the track is labelled with the detected language", /English \(AI\)/.test(ready?.label ?? ""), ready?.label);
const vtt = await (await api.get(`/api/subtitles/${subId}`)).text();
const flat = vtt.replace(/\d\d:\d\d:\d\d\.\d{3} --> .*\n/g, "").replace(/^\d+$/gm, "").replace(/\s+/g, " ").toLowerCase();
// Whisper tiny is not perfect (and the clip went through VP9/Opus): require most of the sentence, not every word
const WANT = ["fellow", "americans", "what", "country", "can", "do", "for", "you"];
const hit = WANT.filter((w) => flat.includes(w)).length;
check("the WebVTT contains the actual speech", hit >= 7 && /country/.test(flat), `${hit}/${WANT.length}: ${flat.slice(0, 160)}`);
const first = /(\d\d):(\d\d):(\d\d)\.(\d{3}) -->/.exec(vtt);
const firstSec = first ? +first[1] * 3600 + +first[2] * 60 + +first[3] + +first[4] / 1000 : -1;
check("cue timing matches the audio (speech starts after 5 s of silence)", firstSec > 4.5 && firstSec < 7.5, String(firstSec));
check("no hallucinated credits over the silence", !/amara|subtitles by|thanks for watching/i.test(vtt));
info = await (await api.get(`/api/media/${files.speech.id}/info`)).json();
check("asking again does not create a second track", info.subtitles.length === 1);
const hdr = await api.get(`/api/subtitles/${subId}`);
check("a finished track is cacheable, a generating one is not", /max-age/.test(hdr.headers()["cache-control"] ?? ""));

// ---- manual: auto off, the user starts it from the player menu
await put({ whisperAuto: false });
info = await (await api.get(`/api/media/${files.quiet.id}/info`)).json();
check("with auto off, no track is created and the player may offer generation", info.subtitles.length === 0 && info.ai?.mayStart === true, JSON.stringify(info.ai));
r = await api.post(`/api/subtitles/ai/${files.quiet.id}`, { data: { startSec: 8 } });
const started = (await r.json()).subtitle;
check("starting manually returns a generating track", r.ok() && ["generating", "ready"].includes(started?.status), JSON.stringify(started));
r = await api.post(`/api/subtitles/ai/${files.quiet.id}`, { data: {} });
check("starting twice returns the same track", (await r.json()).subtitle.id === started.id);
const done2 = await until(async () => { const s = await (await api.get(`/api/subtitles/ai/${files.quiet.id}`)).json(); return s.subtitle?.status === "ready" ? s : null; }, 120000, 1000);
check("manual job (starting at 8 s, wrapping to the beginning) completes", !!done2);
const vtt2 = await (await api.get(`/api/subtitles/${started.id}`)).text();
check("…and covers the whole film", /fellow/i.test(vtt2) && /country/i.test(vtt2), vtt2.slice(0, 200));

// ---- switched off / access control
await put({ whisperEnabled: false });
r = await api.post(`/api/subtitles/ai/${files.speech.id}`, { data: {} });
check("generation is refused when switched off", r.status() === 403);
info = await (await api.get(`/api/media/${files.speech.id}/info`)).json();
check("the player is told it is unavailable", info.ai?.available === false && /turned off/i.test(info.ai.reason ?? ""));
await put({ whisperEnabled: true, whisperAuto: false });
r = await api.post(`/api/subtitles/ai/${"nonexistent"}`, { data: {} });
check("unknown files are a clean 404", r.status() === 404);
r = await api.post(`/api/subtitles/ai/${files.speech.id}`, { data: { language: "xx-yy" } });
check("bad options are rejected", r.status() === 400);
const anon = await request.newContext({ baseURL: BASE });
check("anonymous users cannot start or read", (await anon.post(`/api/subtitles/ai/${files.speech.id}`, { data: {} })).status() === 401 && (await anon.get(`/api/subtitles/ai/${files.speech.id}`)).status() === 401);

// ---- player UI
const browser = await chromium.launch();
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: await api.storageState() });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(BASE + `/watch/${files.speech.id}`);
await page.locator("video").waitFor();
await page.getByRole("button", { name: "Subtitles" }).waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Subtitles" }).click();
check("the subtitle menu lists the AI track", await page.getByText("English (AI)").first().isVisible());
await page.getByText("English (AI)").first().click();
await page.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.play().catch(() => {}); });
await until(async () => page.evaluate(() => document.querySelector("video").readyState >= 2), 30000, 300);
await page.evaluate(() => { document.querySelector("video").currentTime = 9; });
const shown = await until(async () => page.evaluate(() => { const t = [...document.querySelector("video").textTracks].find((x) => x.mode === "showing"); const c = t?.activeCues?.[0]; return c ? c.text : null; }), 20000, 300);
check("the player shows the generated cue at the right moment", !!shown && /fellow|americans|ask not/i.test(shown), String(shown));
await page.screenshot({ path: E + "/shot-subtitles.png" });
check("no uncaught JS errors in the player", errs.filter((e) => !/hydrat|caret/i.test(e)).length === 0, errs.slice(0, 2).join(" | "));
await browser.close();
summary();
