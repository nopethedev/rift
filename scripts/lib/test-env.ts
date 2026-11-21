// Bootstrap for integration test scripts (run with: npx tsx --conditions=react-server scripts/<name>.ts).
// Creates an isolated temp data dir + sqlite DB, applies migrations and pre-creates the Prisma client
// (src/server/db.ts would otherwise use `require`, which only exists inside the Next bundle).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function setupTestEnv(name: string, extraEnv: Record<string, string> = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `rift-${name}-`));
  const dataDir = path.join(tmp, "data");
  const mediaDir = path.join(tmp, "media");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  Object.assign(process.env, {
    DATABASE_URL: `file:${path.join(dataDir, "test.db")}`,
    DATA_DIR: dataDir,
    MEDIA_DIR: mediaDir,
    DOWNLOAD_DIR: path.join(mediaDir, "downloads"),
    TMDB_API_KEY: "",
    ...extraEnv,
  });
  const r = spawnSync(process.execPath, [path.join(root, "scripts/db.mjs"), "setup"], { env: process.env, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("db setup failed");
  }
  const { PrismaClient } = await import("../../src/generated/prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }) });
  (globalThis as unknown as { __riftDb: unknown }).__riftDb = client;
  return { tmp, dataDir, mediaDir, db: client };
}

let failures = 0;
export function check(cond: unknown, msg: string) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}
export const failed = () => failures;

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string, every = 200): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export function ffmpeg(args: string[]) {
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** Tiny real video: 2 s test pattern + tone (+ optional embedded SRT track). */
export function makeVideo(out: string, opts: { seconds?: number; size?: string; srt?: string } = {}) {
  mkdirSync(path.dirname(out), { recursive: true });
  const secs = String(opts.seconds ?? 2);
  const args = ["-f", "lavfi", "-i", `testsrc=duration=${secs}:size=${opts.size ?? "320x240"}:rate=15`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`];
  if (opts.srt) args.push("-i", opts.srt);
  args.push("-map", "0:v", "-map", "1:a");
  if (opts.srt) args.push("-map", "2:s", "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k");
  if (opts.srt) args.push("-c:s", out.endsWith(".mp4") ? "mov_text" : "srt");
  args.push(out);
  ffmpeg(args);
}

export const SRT = `1
00:00:00,000 --> 00:00:01,000
Hello <b>world</b>

2
00:00:01,000 --> 00:00:02,000
Second line
`;
