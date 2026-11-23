#!/usr/bin/env node
// Rift -> Discord Rich Presence companion. Zero dependencies, Node 18+.
//
// Discord only accepts Rich Presence from the desktop app running on YOUR computer, so a server cannot set it directly.
// Run this on the PC where Discord is open. It asks your Rift server what your profile is playing (using your secret
// presence token) and shows it on your Discord profile as "Listening to ..." / "Watching ...".
//
//   node rift-discord-presence.mjs --server https://rift.example.com --token rp_xxxxxxxx
//   (or set RIFT_SERVER and RIFT_PRESENCE_TOKEN)   --dry-run prints what would be shown without talking to Discord.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

/** One IPC frame: int32 opcode, int32 byte length (both little endian), then UTF-8 JSON. */
export function encode(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const b = Buffer.alloc(8 + data.length);
  b.writeInt32LE(op, 0);
  b.writeInt32LE(data.length, 4);
  data.copy(b, 8);
  return b;
}

/** Collects stream chunks and yields whole frames (a frame can arrive split over several chunks, or several per chunk). */
export class FrameReader {
  buf = Buffer.alloc(0);
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 8) {
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > 1 << 20) throw new Error("corrupt IPC frame");
      if (this.buf.length < 8 + len) break;
      const op = this.buf.readInt32LE(0);
      let data = null;
      try { data = JSON.parse(this.buf.subarray(8, 8 + len).toString("utf8")); } catch { /* ignore */ }
      out.push({ op, data });
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

/** Where Discord listens: a unix socket (Linux, macOS, Flatpak, Snap) or a named pipe (Windows), discord-ipc-0 .. 9. */
export function ipcPaths(env = process.env, platform = process.platform) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (platform === "win32") { out.push(`\\\\?\\pipe\\discord-ipc-${i}`); continue; }
    const bases = env.RIFT_DISCORD_IPC_DIR ? [env.RIFT_DISCORD_IPC_DIR] : [
      env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, "/tmp",
      ...(env.XDG_RUNTIME_DIR ? [path.join(env.XDG_RUNTIME_DIR, "app/com.discordapp.Discord"), path.join(env.XDG_RUNTIME_DIR, "snap.discord")] : []),
    ].filter(Boolean);
    for (const b of new Set(bases)) out.push(path.join(b, `discord-ipc-${i}`));
  }
  return out;
}

export class DiscordIpc {
  constructor({ clientId, paths = ipcPaths(), log = () => {} }) { this.clientId = clientId; this.paths = paths; this.log = log; this.sock = null; this.pending = new Map(); this.nonce = 0; this.onclose = null; }
  get connected() { return !!this.sock && !this.sock.destroyed; }

  async connect() {
    let last = null;
    for (const p of this.paths) {
      if (process.platform !== "win32" && !fs.existsSync(p)) continue;
      try { await this.#open(p); this.log(`connected to Discord (${p})`); return; } catch (e) { last = e; }
    }
    throw new Error(last ? `Discord refused the connection: ${last.message}` : "Discord is not running (no IPC socket found)");
  }

  #open(p) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(p);
      const reader = new FrameReader();
      let ready = false;
      const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error("no answer to the handshake")), 5000);
      sock.on("error", (e) => { if (!ready) fail(e); });
      sock.on("close", () => {
        if (!ready) return fail(new Error("closed during the handshake"));
        for (const w of this.pending.values()) w.reject(new Error("Discord closed the connection"));
        this.pending.clear();
        this.sock = null;
        this.onclose?.();
      });
      sock.on("data", (chunk) => {
        let frames;
        try { frames = reader.push(chunk); } catch (e) { return fail(e); }
        for (const { op, data } of frames) {
          if (op === OP.PING) sock.write(encode(OP.PONG, data ?? {}));
          else if (op === OP.CLOSE) { if (!ready) fail(new Error(data?.message || "Discord closed the connection")); else sock.destroy(); }
          else if (op === OP.FRAME) {
            if (!ready && data?.evt === "READY") { ready = true; clearTimeout(timer); this.sock = sock; resolve(); }
            else if (data?.evt === "ERROR" && !ready) fail(new Error(data.data?.message ?? "Discord error"));
            else if (data?.nonce && this.pending.has(data.nonce)) {
              const w = this.pending.get(data.nonce); this.pending.delete(data.nonce);
              data.evt === "ERROR" ? w.reject(new Error(data.data?.message ?? "Discord rejected the activity")) : w.resolve(data);
            }
          }
        }
      });
      sock.on("connect", () => sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId })));
    });
  }

  /** Shows `activity` (Discord's activity object), or clears the status when it is null. */
  setActivity(activity) {
    if (!this.connected) return Promise.reject(new Error("not connected"));
    const nonce = `${Date.now()}-${++this.nonce}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(nonce); reject(new Error("Discord did not answer")); }, 8000);
      this.pending.set(nonce, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.sock.write(encode(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, ...(activity ? { activity: { instance: false, ...activity } } : {}) }, nonce }));
    });
  }

  close() { try { this.sock?.destroy(); } catch { /* ignore */ } this.sock = null; }
}

/** The polling loop. Returns a `stop()` that clears the status and disconnects. */
export function runPresence({ server, token, clientId: forcedClientId, pollMs = 5000, dryRun = false, ipc: ipcOpts = {}, log = console.log, onUpdate = () => {} }) {
  const base = server.replace(/\/+$/, "");
  let ipc = null;
  let stopped = false;
  let lastKey = "";
  let lastClientId = "";
  let wasDown = false;
  let timer = null;

  const say = (() => { const seen = new Set(); return (k, msg) => { if (!seen.has(k)) { seen.add(k); log(msg); } }; })();

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(`${base}/api/presence/${encodeURIComponent(token)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) { log("The presence token is unknown or was revoked. Create a new one on the Rift website (Account menu -> Discord presence)."); return stop(1); }
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      wasDown = false;
      const snap = await res.json();
      const clientId = forcedClientId || snap.clientId;
      if (!clientId) { say("noid", "Rift has no Discord Application ID yet: an admin sets it in Admin -> Settings -> Discord Rich Presence."); return; }
      const activity = snap.activity ?? null;
      const key = JSON.stringify([clientId, activity]);
      if (dryRun) { if (key !== lastKey) { lastKey = key; log(activity ? `would show: ${activity.type === 3 ? "Watching" : "Listening to"} ${activity.details} - ${activity.state}` : "nothing playing (status cleared)"); onUpdate(activity); } return; }
      if (clientId !== lastClientId) { ipc?.close(); ipc = null; lastClientId = clientId; lastKey = ""; }
      if (!ipc?.connected) {
        ipc = new DiscordIpc({ clientId, ...ipcOpts, log });
        ipc.onclose = () => { lastKey = ""; };
        try { await ipc.connect(); lastKey = ""; } catch (e) { say(`d:${e.message}`, `${e.message}. Waiting for Discord...`); ipc = null; return; }
      }
      if (key === lastKey) return;
      await ipc.setActivity(activity);
      lastKey = key;
      log(activity ? `showing: ${activity.type === 3 ? "Watching" : "Listening to"} ${activity.details} - ${activity.state}` : "status cleared");
      onUpdate(activity);
    } catch (e) {
      if (!wasDown) log(`cannot reach ${base}: ${e.message}. Retrying...`);
      wasDown = true;
    }
  }

  const loop = async () => { await tick(); if (!stopped) timer = setTimeout(loop, pollMs); };
  void loop();

  async function stop(code) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    try { if (ipc?.connected) await Promise.race([ipc.setActivity(null), new Promise((r) => setTimeout(r, 1000))]); } catch { /* ignore */ }
    ipc?.close();
    if (typeof code === "number") process.exitCode = code;
  }
  return stop;
}

function cli() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node rift-discord-presence.mjs --server <https://your-rift> --token <rp_...> [--client-id <id>] [--poll <seconds>] [--dry-run]\nEnvironment: RIFT_SERVER, RIFT_PRESENCE_TOKEN, DISCORD_CLIENT_ID");
    return;
  }
  const server = arg("server") || process.env.RIFT_SERVER;
  const token = arg("token") || process.env.RIFT_PRESENCE_TOKEN;
  if (!server || !token) { console.error("Missing --server and/or --token (see --help). Get both on the Rift website: Account menu -> Discord presence."); process.exitCode = 2; return; }
  const stop = runPresence({ server, token, clientId: arg("client-id") || process.env.DISCORD_CLIENT_ID, pollMs: Math.max(2, Number(arg("poll")) || 5) * 1000, dryRun: args.includes("--dry-run") });
  console.log(`Rift presence for ${os.hostname()}: watching ${server}. Press Ctrl+C to stop.`);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void stop(0).then(() => process.exit()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();
