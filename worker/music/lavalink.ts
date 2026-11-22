// Lavalink v4 client: REST + the session WebSocket, for any number of nodes.
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { LavalinkNodeConfig } from "../../shared/music-protocol";

export interface LavalinkTrack {
  encoded: string;
  info: { identifier: string; title: string; author: string; length: number; isStream: boolean; uri?: string; artworkUrl?: string; sourceName: string };
}
export interface LoadResult { loadType: "track" | "playlist" | "search" | "empty" | "error"; data: unknown }

const USER_ID = "839204651922870272"; // arbitrary snowflake identifying Rift to the node

export class LavalinkNode extends EventEmitter {
  sessionId: string | null = null;
  online = false;
  lastError?: string;
  version?: string;
  players = 0;
  cpu = 0;
  private ws?: WebSocket;
  private stopped = false;
  private retry = 1000;
  private ready: Promise<string>;
  private onReady!: (id: string) => void;

  constructor(public cfg: LavalinkNodeConfig) {
    super();
    this.ready = new Promise((res) => (this.onReady = res));
    this.ready.catch(() => {});
  }

  private get base() { return this.cfg.url.replace(/\/$/, ""); }
  private get headers() { return { Authorization: this.cfg.password }; }

  connect() {
    if (this.stopped) return;
    const url = this.base.replace(/^http/i, "ws") + "/v4/websocket";
    const ws = new WebSocket(url, { headers: { ...this.headers, "User-Id": USER_ID, "Client-Name": "rift-music/1.0" }, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on("message", (raw) => {
      let m: { op: string; sessionId?: string; type?: string; guildId?: string; players?: number; cpu?: { lavalinkLoad?: number } };
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.op === "ready" && m.sessionId) {
        this.sessionId = m.sessionId;
        this.online = true;
        this.lastError = undefined;
        this.retry = 1000;
        this.onReady(m.sessionId);
      } else if (m.op === "stats") {
        this.players = m.players ?? 0;
        this.cpu = m.cpu?.lavalinkLoad ?? 0;
      } else if (m.op === "event") this.emit("event", m);
    });
    ws.on("error", (e) => { this.lastError = e.message; });
    ws.on("close", () => {
      this.online = false;
      this.sessionId = null;
      this.ready = new Promise((res) => (this.onReady = res));
      this.ready.catch(() => {});
      if (!this.stopped) setTimeout(() => this.connect(), (this.retry = Math.min(this.retry * 2, 30_000))).unref();
    });
  }

  close() {
    this.stopped = true;
    this.ws?.terminate();
  }

  waitReady(ms = 10_000): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    return Promise.race([this.ready, new Promise<string>((_, rej) => setTimeout(() => rej(new Error(`Lavalink node "${this.cfg.name}" is not connected${this.lastError ? `: ${this.lastError}` : ""}`)), ms).unref())]);
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method,
      headers: { ...this.headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Lavalink ${method} ${path.split("?")[0]} -> ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  async load(identifier: string): Promise<LoadResult> {
    return this.rest<LoadResult>("GET", `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
  }

  async search(prefix: string, text: string): Promise<LavalinkTrack[]> {
    const r = await this.load(`${prefix}:${text}`);
    if (r.loadType === "search") return r.data as LavalinkTrack[];
    if (r.loadType === "track") return [r.data as LavalinkTrack];
    if (r.loadType === "playlist") return (r.data as { tracks: LavalinkTrack[] }).tracks;
    if (r.loadType === "error") throw new Error((r.data as { message?: string }).message ?? "Lavalink load error");
    return [];
  }

  async play(guildId: string, encoded: string, voice: { token: string; endpoint: string; sessionId: string; channelId: string }) {
    const sid = await this.waitReady();
    await this.rest("PATCH", `/v4/sessions/${sid}/players/${guildId}?noReplace=false`, { track: { encoded }, voice, volume: 100, paused: false });
  }

  async destroy(guildId: string) {
    if (!this.sessionId) return;
    await this.rest("DELETE", `/v4/sessions/${this.sessionId}/players/${guildId}`).catch(() => {});
  }

  async info(): Promise<{ version: string; plugins: { name: string; version: string }[]; sourceManagers: string[] }> {
    const i = await this.rest<{ version: { semver: string }; plugins: { name: string; version: string }[]; sourceManagers: string[] }>("GET", "/v4/info");
    this.version = i.version.semver;
    return { version: i.version.semver, plugins: i.plugins, sourceManagers: i.sourceManagers };
  }
}

export class LavalinkPool {
  private nodes = new Map<string, LavalinkNode>();

  /** Reconcile with the configured node list (add / update / remove). */
  sync(configs: LavalinkNodeConfig[]) {
    const ids = new Set(configs.map((c) => c.id));
    for (const [id, n] of this.nodes) if (!ids.has(id)) { n.close(); this.nodes.delete(id); }
    for (const c of configs) {
      const cur = this.nodes.get(c.id);
      if (cur && cur.cfg.url === c.url && cur.cfg.password === c.password) { cur.cfg = c; continue; }
      cur?.close();
      const n = new LavalinkNode(c);
      this.nodes.set(c.id, n);
      n.connect();
    }
  }

  get(id?: string) { return id ? this.nodes.get(id) : undefined; }

  /** Online nodes first, least loaded first. */
  ordered(): LavalinkNode[] {
    return [...this.nodes.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.players + a.cpu * 10 - (b.players + b.cpu * 10));
  }

  all() { return [...this.nodes.values()]; }
  close() { for (const n of this.nodes.values()) n.close(); this.nodes.clear(); }
}
