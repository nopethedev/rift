import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The companion is a plain .mjs script served from /public; load it like a user's machine would.
const lib = (await import(/* @vite-ignore */ path.resolve(import.meta.dirname, "../public/rift-discord-presence.mjs"))) as {
  encode(op: number, p: unknown): Buffer;
  FrameReader: new () => { push(b: Buffer): { op: number; data: unknown }[] };
  ipcPaths(env: Record<string, string | undefined>, platform: string): string[];
  runPresence(o: Record<string, unknown>): () => Promise<void>;
};

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const until = async <T,>(f: () => T | undefined | false, ms = 4000): Promise<T> => { const t = Date.now(); for (;;) { const v = f(); if (v) return v as T; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

/** A stand-in for the Discord desktop app: unix socket, handshake -> READY, SET_ACTIVITY -> acknowledged. */
function fakeDiscord(dir: string, opts: { rejectId?: string } = {}) {
  const got: { clientId?: string; activities: (Record<string, unknown> | null)[] } = { activities: [] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    const r = new lib.FrameReader();
    s.on("data", (c: Buffer) => {
      for (const { op, data } of r.push(c)) {
        const d = data as { client_id?: string; cmd?: string; nonce?: string; args?: { activity?: Record<string, unknown> } };
        if (op === 0) {
          got.clientId = d.client_id;
          if (opts.rejectId === d.client_id) { s.write(lib.encode(2, { code: 4000, message: "Invalid Client ID" })); s.end(); return; }
          s.write(lib.encode(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } }));
        } else if (op === 1 && d.cmd === "SET_ACTIVITY") {
          got.activities.push(d.args?.activity ?? null);
          s.write(lib.encode(1, { cmd: "SET_ACTIVITY", evt: null, nonce: d.nonce, data: {} }));
        }
      }
    });
    s.on("close", () => sockets.delete(s));
  });
  server.listen(path.join(dir, "discord-ipc-0"));
  const close = () => new Promise<void>((res) => { for (const s of sockets) s.destroy(); server.close(() => res()); });
  cleanup.push(close);
  return { got, close, kill: () => { for (const s of sockets) s.destroy(); } };
}

function fakeRift(state: { clientId: string; activity: Record<string, unknown> | null; status?: number }) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(state.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(state.status && state.status !== 200 ? { error: "nope" } : { profile: "Test", clientId: state.clientId, activity: state.activity }));
  });
  return new Promise<{ url: string; hits: string[] }>((resolve) => server.listen(0, "127.0.0.1", () => {
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    resolve({ url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, hits });
  }));
}

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rift-ipc-")); cleanup.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const song = { type: 2, details: "Tone One", state: "by Test Artist", timestamps: { start: 1000, end: 15000 }, assets: { large_image: "https://cdn.dzcdn.net/x.jpg", large_text: "Test Album" } };

describe("IPC framing", () => {
  it("round-trips frames and copes with split and merged chunks", () => {
    const a = lib.encode(1, { cmd: "X", n: 1 }), b = lib.encode(3, { t: "é" });
    const r = new lib.FrameReader();
    const all = Buffer.concat([a, b]);
    expect(r.push(all.subarray(0, 5))).toEqual([]);
    expect(r.push(all.subarray(5, a.length + 3))).toEqual([{ op: 1, data: { cmd: "X", n: 1 } }]);
    expect(r.push(all.subarray(a.length + 3))).toEqual([{ op: 3, data: { t: "é" } }]);
  });
  it("rejects absurd frame lengths", () => {
    const bad = Buffer.alloc(8); bad.writeInt32LE(1, 0); bad.writeInt32LE(1 << 30, 4);
    expect(() => new lib.FrameReader().push(bad)).toThrow();
  });
  it("knows where Discord listens on each platform", () => {
    expect(lib.ipcPaths({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toContain("/run/user/1000/discord-ipc-0");
    expect(lib.ipcPaths({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toContain("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0");
    expect(lib.ipcPaths({}, "win32")[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
  });
});

describe("companion", () => {
  it("shows what the server reports, updates it, and clears it", async () => {
    const dir = tmp();
    const d = fakeDiscord(dir);
    const state = { clientId: "123456789012345678", activity: song as Record<string, unknown> | null };
    const rift = await fakeRift(state);
    const stop = lib.runPresence({ server: rift.url, token: "rp_abcdefghijklmnopqrstuv", pollMs: 40, ipc: { paths: [path.join(dir, "discord-ipc-0")] }, log: () => {} });
    cleanup.push(stop);
    await until(() => d.got.activities.length === 1);
    expect(d.got.clientId).toBe("123456789012345678");
    expect(d.got.activities[0]).toMatchObject({ type: 2, details: "Tone One", state: "by Test Artist", instance: false, timestamps: { start: 1000 }, assets: { large_image: "https://cdn.dzcdn.net/x.jpg" } });
    expect(rift.hits[0]).toBe("/api/presence/rp_abcdefghijklmnopqrstuv");
    await new Promise((r) => setTimeout(r, 200));
    expect(d.got.activities.length).toBe(1); // unchanged state is not re-sent
    state.activity = { ...song, details: "Tone Two" };
    await until(() => d.got.activities.length === 2);
    expect(d.got.activities[1]).toMatchObject({ details: "Tone Two" });
    state.activity = null;
    await until(() => d.got.activities.length === 3);
    expect(d.got.activities[2]).toBeNull();
  });

  it("waits for Discord to start, then connects; reconnects after Discord restarts", async () => {
    const dir = tmp();
    const state = { clientId: "123456789012345678", activity: song as Record<string, unknown> | null };
    const rift = await fakeRift(state);
    const logs: string[] = [];
    const stop = lib.runPresence({ server: rift.url, token: "rp_abcdefghijklmnopqrstuv", pollMs: 40, ipc: { paths: [path.join(dir, "discord-ipc-0")] }, log: (m: string) => logs.push(m) });
    cleanup.push(stop);
    await until(() => logs.some((l) => /not running/i.test(l)));
    const d1 = fakeDiscord(dir);
    await until(() => d1.got.activities.length === 1);
    await d1.close();
    fs.rmSync(path.join(dir, "discord-ipc-0"), { force: true });
    const d2 = fakeDiscord(dir);
    await until(() => d2.got.activities.length === 1); // shown again on the new connection
  });

  it("dry run prints without touching Discord, and a revoked token stops the loop", async () => {
    const dir = tmp();
    const state = { clientId: "123456789012345678", activity: song as Record<string, unknown> | null, status: 200 };
    const rift = await fakeRift(state);
    const logs: string[] = [];
    const stop = lib.runPresence({ server: rift.url, token: "rp_abcdefghijklmnopqrstuv", pollMs: 40, dryRun: true, ipc: { paths: [path.join(dir, "discord-ipc-0")] }, log: (m: string) => logs.push(m) });
    await until(() => logs.some((l) => l.includes("Tone One")));
    state.status = 404;
    await until(() => logs.some((l) => /revoked/.test(l)));
    const n = rift.hits.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(rift.hits.length).toBeLessThanOrEqual(n + 1); // stopped polling
    await stop();
    process.exitCode = 0;
  });

  it("explains a missing Application ID instead of failing", async () => {
    const dir = tmp();
    const rift = await fakeRift({ clientId: "", activity: song });
    const logs: string[] = [];
    const stop = lib.runPresence({ server: rift.url, token: "rp_abcdefghijklmnopqrstuv", pollMs: 40, ipc: { paths: [path.join(dir, "discord-ipc-0")] }, log: (m: string) => logs.push(m) });
    cleanup.push(stop);
    await until(() => logs.some((l) => /Application ID/.test(l)));
  });
});
