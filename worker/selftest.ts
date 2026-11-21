// End-to-end self test for the transcoding worker: `npm run test:worker`
// Generates test clips with ffmpeg lavfi, runs the worker in-process on a random port and exercises the API.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionStatus, StartSessionResponse, WorkerHealth } from "../shared/worker-protocol";
import { loadConfig } from "./config";
import { startWorker, type RunningWorker } from "./index";
import { TS_BASE_SECONDS } from "./ffmpeg";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const TOKEN = "selftest-token";

let failures = 0;
let passes = 0;
function check(cond: unknown, msg: string) {
  if (cond) {
    passes++;
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helpers (raw node:http so ".." in paths is sent verbatim) ----------

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  ms: number;
}

let PORT = 0;
function request(method: string, p: string, opts: { body?: unknown; auth?: boolean } = {}): Promise<Res> {
  const t0 = Date.now();
  const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path: p,
        headers: {
          ...(opts.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
          ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - t0 }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const json = <T>(r: Res) => JSON.parse(r.body.toString("utf8")) as T;

// ---------- media helpers ----------

async function makeClip(file: string, seconds: number, size: string) {
  await exec(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=d=${seconds}:s=${size}:r=24`,
    "-f", "lavfi", "-i", `sine=f=440:d=${seconds}:r=48000`,
    "-filter_complex", "[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "240",
    "-c:a", "eac3", "-b:a", "384k",
    file,
  ]);
}

interface SegInfo {
  format: string;
  vcodec?: string;
  acodec?: string;
  channels?: number;
  sampleRate?: number;
  vStart: number;
  vEnd: number;
  aStart: number;
  aEnd: number;
  firstIsKey: boolean;
}

async function probeSegment(file: string): Promise<SegInfo> {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-show_packets", "-of", "json", file], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const j = JSON.parse(stdout) as {
    format: { format_name: string };
    streams: Array<{ index: number; codec_type: string; codec_name: string; channels?: number; sample_rate?: string }>;
    packets: Array<{ stream_index: number; pts_time?: string; duration_time?: string; flags: string }>;
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const range = (idx?: number) => {
    const ps = j.packets.filter((p) => p.stream_index === idx && p.pts_time !== undefined);
    const pts = ps.map((p) => Number(p.pts_time));
    const last = ps.reduce((m, p) => Math.max(m, Number(p.pts_time) + Number(p.duration_time ?? 0)), -Infinity);
    return { start: Math.min(...pts), end: last, first: ps[0] };
  };
  const vr = range(v?.index);
  const ar = range(a?.index);
  return {
    format: j.format.format_name,
    vcodec: v?.codec_name,
    acodec: a?.codec_name,
    channels: a?.channels,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
    vStart: vr.start,
    vEnd: vr.end,
    aStart: ar.start,
    aEnd: ar.end,
    firstIsKey: !!vr.first?.flags.includes("K"),
  };
}

async function ffmpegChildren(): Promise<string[]> {
  const { stdout } = await exec("ps", ["-o", "pid=,stat=,args=", "--ppid", String(process.pid)]).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /ffmpeg/.test(l));
}

async function fetchSegment(dir: string, sid: string, height: number, n: number): Promise<{ res: Res; info?: SegInfo }> {
  const res = await request("GET", `/hls/${sid}/v${height}/seg_${n}.ts`);
  if (res.status !== 200) return { res };
  const file = path.join(dir, `${sid}_v${height}_${n}.ts`);
  await import("node:fs/promises").then((f) => f.writeFile(file, res.body));
  return { res, info: await probeSegment(file) };
}

// ---------- test ----------

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "rift-worker-selftest-"));
  const work = path.join(tmp, "transcode");
  let worker: RunningWorker | undefined;
  try {
    console.log(`[selftest] temp dir ${tmp}`);
    const clip = path.join(tmp, "clip.mkv");
    const longClip = path.join(tmp, "long.mkv");
    await Promise.all([makeClip(clip, 40, "1280x720"), makeClip(longClip, 200, "320x240")]);
    console.log("[selftest] clips generated");

    // stale session dir that must be cleaned on startup
    await import("node:fs/promises").then(async (f) => {
      await f.mkdir(path.join(work, "stale1"), { recursive: true });
      await f.writeFile(path.join(work, "stale1", ".rift-session.json"), "{}");
    });

    worker = await startWorker(
      loadConfig({ port: 0, host: "127.0.0.1", token: TOKEN, transcodeDir: work, maxSessions: 2, idleSeconds: 8 }),
    );
    PORT = worker.port;
    check(!existsSync(path.join(work, "stale1")), "stale session dir removed on startup");

    console.log("[selftest] health + auth");
    const health = await request("GET", "/health", { auth: false });
    check(health.status === 200 && json<WorkerHealth>(health).ok === true, "GET /health without token -> 200");
    check(json<WorkerHealth>(health).maxSessions === 2 && Array.isArray(json<WorkerHealth>(health).hwaccels), "health has maxSessions + hwaccels");
    check((await request("GET", "/sessions", { auth: false })).status === 401, "GET /sessions without token -> 401");
    check((await request("GET", "/hls/a/master.m3u8", { auth: false })).status === 401, "GET /hls without token -> 401");
    const badTok = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/sessions", headers: { authorization: "Bearer wrong" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
    });
    check(badTok === 401, "wrong token -> 401");

    console.log("[selftest] validation + traversal");
    check((await request("POST", "/sessions", { body: { sessionId: "../x", inputPath: clip, ladder: [720], hwaccel: "none" } })).status === 400, "bad sessionId -> 400");
    check((await request("POST", "/sessions", { body: { sessionId: "rel", inputPath: "../clip.mkv", ladder: [720], hwaccel: "none" } })).status === 400, "relative inputPath -> 400");
    check((await request("POST", "/sessions", { body: { sessionId: "nofile", inputPath: path.join(tmp, "nope.mkv"), ladder: [720], hwaccel: "none" } })).status === 404, "missing inputPath -> 404");
    check((await request("POST", "/sessions", { body: { sessionId: "dir", inputPath: tmp, ladder: [720], hwaccel: "none" } })).status === 404, "directory inputPath -> 404");

    console.log("[selftest] create session");
    const t0 = Date.now();
    const created = await request("POST", "/sessions", { body: { sessionId: "s1", inputPath: clip, ladder: [1080, 720, 480], hwaccel: "nvenc" } });
    check(created.status === 200, `POST /sessions -> 200 (${Date.now() - t0} ms)`);
    const cr = json<StartSessionResponse>(created);
    check(cr.reused === false && cr.masterPath === "/hls/s1/master.m3u8", "response masterPath/reused");
    check(Math.abs(cr.duration - 40) < 0.2, `duration ~40 (${cr.duration})`);
    check(JSON.stringify(cr.variants.map((v) => v.height)) === "[720,480]", `1080 dropped -> ${cr.variants.map((v) => v.height)}`);
    check(cr.variants[0].width === 1280 && cr.variants[1].width === 854, "variant widths");

    for (const p of [
      "/hls/s1/v720/../../stale1/x.ts",
      "/hls/s1/v720/..%2F..%2F.rift-session.json",
      "/hls/..%2F..%2Fetc/master.m3u8",
      "/hls/s1/%2e%2e/master.m3u8",
      "/hls/s1/v720/seg_..%2F1.ts",
      "/sessions/..%2Fs1",
    ]) {
      const r = await request("GET", p);
      check(r.status === 400 || r.status === 404, `traversal ${p} -> ${r.status}`);
    }
    check((await request("GET", "/hls/s1/v1080/index.m3u8")).status === 404, "dropped variant -> 404");
    check((await request("GET", "/hls/s1/v720/seg_7.ts")).status === 404, "segment out of range -> 404");

    const master = await request("GET", "/hls/s1/master.m3u8");
    const mtext = master.body.toString();
    check(master.status === 200 && master.headers["content-type"] === "application/vnd.apple.mpegurl", "master content-type");
    check(master.headers["cache-control"] === "no-store", "master Cache-Control no-store");
    check(/BANDWIDTH=\d+/.test(mtext) && mtext.includes("RESOLUTION=1280x720") && mtext.includes('CODECS="avc1.640028,mp4a.40.2"'), "master lists BANDWIDTH/RESOLUTION/CODECS");
    check(mtext.includes("v720/index.m3u8") && mtext.includes("v480/index.m3u8"), "master lists variants");

    const vp = await request("GET", "/hls/s1/v720/index.m3u8");
    const vtext = vp.body.toString();
    const durs = [...vtext.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
    check(vtext.includes("#EXT-X-PLAYLIST-TYPE:VOD") && vtext.trim().endsWith("#EXT-X-ENDLIST"), "variant is complete VOD playlist");
    check(durs.length === 7 && durs.slice(0, 6).every((d) => d === 6) && Math.abs(durs[6] - 4) < 0.01, `segment durations ${durs}`);
    check(vp.headers["cache-control"] === "no-store", "variant Cache-Control no-store");

    console.log("[selftest] jump-ahead seek to last segment first");
    const segs = new Map<number, SegInfo>();
    const last = await fetchSegment(tmp, "s1", 720, 6);
    check(last.res.status === 200 && last.res.headers["content-type"] === "video/mp2t", `seg_6 200 video/mp2t (${last.res.ms} ms)`);
    check(String(last.res.headers["cache-control"]).includes("immutable"), "segment Cache-Control immutable");
    if (last.info) segs.set(6, last.info);

    console.log("[selftest] back to start (restart behind the produced range)");
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const r = await fetchSegment(tmp, "s1", 720, n);
      check(r.res.status === 200, `seg_${n} 200 (${r.res.ms} ms)`);
      if (r.info) segs.set(n, r.info);
    }
    for (const [n, info] of [...segs.entries()].sort((a, b) => a[0] - b[0])) {
      check(info.format === "mpegts" && info.vcodec === "h264" && info.acodec === "aac", `seg_${n} mpegts h264+aac`);
      check(info.channels === 2 && info.sampleRate === 48000, `seg_${n} audio stereo 48k`);
      check(info.firstIsKey, `seg_${n} starts with keyframe`);
      const expect = n * 6 + TS_BASE_SECONDS;
      check(Math.abs(info.vStart - expect) < 0.05, `seg_${n} video starts at ${info.vStart.toFixed(3)} (expect ${expect})`);
    }
    for (let n = 0; n < 6; n++) {
      const a = segs.get(n);
      const b = segs.get(n + 1);
      if (!a || !b) continue;
      const vGap = b.vStart - a.vEnd;
      const aGap = b.aStart - a.aEnd;
      check(vGap > -0.001 && vGap < 0.05, `video continuous seg_${n}->seg_${n + 1} (gap ${vGap.toFixed(4)})`);
      check(aGap > -0.05 && aGap < 0.1, `audio continuous seg_${n}->seg_${n + 1} (gap ${aGap.toFixed(4)})`);
    }
    const again = await request("GET", "/hls/s1/v720/seg_3.ts");
    check(again.status === 200 && again.ms < 200, `cached segment served instantly (${again.ms} ms)`);

    console.log("[selftest] second variant, mid-file seek");
    const v480 = await fetchSegment(tmp, "s1", 480, 3);
    check(v480.res.status === 200 && v480.info?.vcodec === "h264", `v480 seg_3 200 (${v480.res.ms} ms)`);
    check(v480.info !== undefined && Math.abs(v480.info.vStart - (18 + TS_BASE_SECONDS)) < 0.05, "v480 seg_3 timestamps aligned with v720");

    const st = json<SessionStatus>(await request("GET", "/sessions/s1"));
    check(st.sessionId === "s1" && st.segmentsTotal === 7 && st.segmentsReady === 7, `status segmentsReady ${st.segmentsReady}/${st.segmentsTotal}`);
    check(st.hwaccel === "none", `unusable nvenc falls back to software (hwaccel=${st.hwaccel})`);
    check(["running", "idle"].includes(st.state) && !st.error, `status state ${st.state}`);

    console.log("[selftest] session limit");
    const reuse = await request("POST", "/sessions", { body: { sessionId: "s1", inputPath: clip, ladder: [1080, 720, 480], hwaccel: "nvenc" } });
    check(reuse.status === 200 && json<StartSessionResponse>(reuse).reused === true, "same sessionId -> reused");
    const s2 = await request("POST", "/sessions", { body: { sessionId: "s2", inputPath: longClip, ladder: [720, 480], hwaccel: "none" } });
    check(s2.status === 200, "second session -> 200");
    const s2r = json<StartSessionResponse>(s2);
    check(s2r.variants.length === 1 && s2r.variants[0].height === 240, `ladder above source keeps source height (${s2r.variants.map((v) => v.height)})`);
    const s3 = await request("POST", "/sessions", { body: { sessionId: "s3", inputPath: clip, ladder: [480], hwaccel: "none" } });
    check(s3.status === 429 && typeof json<{ error: string }>(s3).error === "string", "third session -> 429 JSON");
    const reuse2 = await request("POST", "/sessions", { body: { sessionId: "s1", inputPath: clip, ladder: [1080, 720, 480], hwaccel: "nvenc" } });
    check(reuse2.status === 200, "reuse while full -> 200 (does not count)");
    const list = json<SessionStatus[]>(await request("GET", "/sessions"));
    check(list.length === 2, `GET /sessions lists ${list.length}`);

    console.log("[selftest] delete");
    const del = await request("DELETE", "/sessions/s1");
    check(del.status === 200, "DELETE /sessions/s1 -> 200");
    check(!existsSync(path.join(work, "s1")), "s1 output deleted");
    check((await request("GET", "/sessions/s1")).status === 404, "GET deleted session -> 404");
    check((await request("GET", "/hls/s1/master.m3u8")).status === 404, "deleted session playlist -> 404");
    check((await request("DELETE", "/sessions/s1")).status === 404, "DELETE again -> 404");
    await sleep(300);
    check(!(await ffmpegChildren()).some((l) => l.includes(path.join(work, "s1"))), "s1 ffmpeg processes gone");

    console.log("[selftest] ffmpeg failure -> error state");
    const doomed = path.join(tmp, "doomed.mkv");
    await import("node:fs/promises").then((f) => f.copyFile(longClip, doomed));
    check((await request("POST", "/sessions", { body: { sessionId: "s3", inputPath: doomed, ladder: [240], hwaccel: "none" } })).status === 200, "s3 created");
    check((await request("GET", "/hls/s3/v240/seg_0.ts")).status === 200, "s3 seg_0 200");
    rmSync(doomed);
    const failed = await request("GET", "/hls/s3/v240/seg_30.ts");
    check(failed.status === 502, `seek restart on a vanished input -> ${failed.status}`);
    const s3st = json<SessionStatus>(await request("GET", "/sessions/s3"));
    check(s3st.state === "error" && typeof s3st.error === "string" && s3st.error.length > 0, `state error with stderr tail: ${JSON.stringify(s3st.error?.split("\n")[0])}`);
    check((await request("DELETE", "/sessions/s3")).status === 200, "s3 deleted");

    console.log("[selftest] throttling (SIGSTOP when far ahead)");
    const first = await request("GET", "/hls/s2/v240/seg_0.ts");
    check(first.status === 200, "s2 seg_0 200");
    let s2st: SessionStatus | undefined;
    for (let i = 0; i < 100; i++) {
      s2st = json<SessionStatus>(await request("GET", "/sessions/s2"));
      if (s2st.state === "idle") break;
      await sleep(200);
    }
    check(s2st?.state === "idle", `s2 paused -> idle (ready ${s2st?.segmentsReady}/${s2st?.segmentsTotal})`);
    await sleep(1500);
    const s2later = json<SessionStatus>(await request("GET", "/sessions/s2"));
    check(s2later.segmentsReady === s2st?.segmentsReady && s2later.segmentsReady <= 23 && s2later.segmentsReady < s2later.segmentsTotal, `no progress while paused (${s2later.segmentsReady})`);
    const kids = await ffmpegChildren();
    const stopped = kids.filter((l) => /^\d+\s+T/.test(l));
    if (!stopped.length) console.log(kids);
    check(stopped.length >= 1, `paused ffmpeg is in stopped state (${stopped.length})`);
    const resumeSeg = await request("GET", "/hls/s2/v240/seg_15.ts");
    check(resumeSeg.status === 200, "existing segment after pause 200");
    let resumed = false;
    for (let i = 0; i < 50 && !resumed; i++) {
      await sleep(200);
      resumed = json<SessionStatus>(await request("GET", "/sessions/s2")).segmentsReady > s2later.segmentsReady;
    }
    check(resumed, "encoder resumes when the player catches up");

    console.log("[selftest] idle reaping (8 s)");
    const t1 = Date.now();
    let gone = false;
    while (Date.now() - t1 < 20_000 && !gone) {
      await sleep(1000);
      gone = !json<SessionStatus[]>(await request("GET", "/sessions")).some((s) => s.sessionId === "s2");
    }
    check(gone, `idle session reaped after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    check(!existsSync(path.join(work, "s2")), "reaped session output deleted");

    console.log("[selftest] shutdown");
    await request("POST", "/sessions", { body: { sessionId: "s4", inputPath: longClip, ladder: [240], hwaccel: "auto" } });
    await sleep(500);
    await worker.stop();
    worker = undefined;
    await sleep(300);
    check((await ffmpegChildren()).length === 0, "no ffmpeg children after shutdown");
  } finally {
    if (worker) await worker.stop().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n[selftest] ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("[selftest] crashed:", err);
  process.exit(1);
});
