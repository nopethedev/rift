import "server-only";
import { mkdir, readFile, writeFile, rm, rmdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/server/db";
import { paths } from "@/server/config";
import { getSettings } from "@/server/settings";
import type { Download } from "@/generated/prisma/client";
import { importDownload } from "@/server/library/importer";
import { TorrentError } from "./errors";
import { buildMagnet, parseMagnet, parseTorrentFile, safePathSegment, type TorrentFileEntry, type TorrentMeta } from "./metainfo";
import { dirUsageBytes, formatBytes, freeBytes, GiB } from "./storage";

export { TorrentError } from "./errors";

export type DownloadStatus = "queued" | "metadata" | "downloading" | "paused" | "completed" | "importing" | "imported" | "error";

export interface DownloadFileView {
  index: number;
  path: string;
  size: number;
  selected: boolean;
  progress: number;
}

export interface DownloadView {
  id: string;
  infoHash: string;
  name: string;
  status: DownloadStatus;
  progress: number;
  size: number;
  downloaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  ratio: number;
  eta: number | null;
  files: DownloadFileView[];
  error?: string | null;
  tmdbId?: number | null;
  mediaType?: "movie" | "tv" | null;
  season?: number | null;
  savePath: string;
  createdAt: string;
  completedAt?: string | null;
}

export interface AddTorrentInput {
  magnet?: string;
  torrentFile?: Buffer;
  selectedFiles?: number[];
  tmdbId?: number;
  mediaType?: "movie" | "tv";
  season?: number;
  createdBy?: string;
}

export interface TorrentPreview {
  infoHash: string;
  name: string;
  totalSize: number;
  files: { index: number; path: string; size: number }[];
}

// ---- minimal structural types for the parts of webtorrent we use (it ships no typings) ----
interface WtFile {
  path: string;
  length: number;
  downloaded: number;
  progress: number;
  done: boolean;
  select(priority?: number): void;
  deselect(): void;
}
interface WtTorrent {
  infoHash: string;
  name: string;
  files: WtFile[];
  pieces: unknown[];
  torrentFile?: Uint8Array;
  metadata?: unknown;
  ready: boolean;
  destroyed: boolean;
  downloadSpeed: number;
  uploadSpeed: number;
  uploaded: number;
  received: number;
  numPeers: number;
  on(ev: string, fn: (...a: any[]) => void): void;
  once(ev: string, fn: (...a: any[]) => void): void;
  removeListener(ev: string, fn: (...a: any[]) => void): void;
  select(start: number, end: number, priority?: number): void;
  deselect(start: number, end: number): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
  addPeer(peer: string): boolean;
}
interface WtClient {
  torrents: WtTorrent[];
  destroyed: boolean;
  add(id: string | Uint8Array, opts?: Record<string, unknown>): WtTorrent;
  throttleDownload(rate: number): void;
  throttleUpload(rate: number): void;
  on(ev: string, fn: (...a: any[]) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}

interface Active {
  id: string;
  infoHash: string;
  torrent: WtTorrent;
  selected: number[] | null;
  lastPersist: number;
  finishing: boolean;
  /** File list from our own metadata parser (paths as stored in the DB). */
  files: TorrentFileEntry[] | null;
}

const METADATA_TIMEOUT_ADD = 60_000;
const METADATA_TIMEOUT_PREVIEW = 45_000;
const PERSIST_EVERY = 5_000;
const STORAGE_CHECK_EVERY = 15_000;
/** Below this much free disk space active downloads are paused. */
const MIN_FREE_BYTES = 256 * 1024 * 1024;

const jsonParse = <T,>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type StoredFile = TorrentFileEntry & { progress?: number };

export interface TorrentManagerOptions {
  /** Extra options merged into `new WebTorrent(...)` (used by tests, e.g. `{ dht: false }`). */
  clientOptions?: Record<string, unknown>;
}

export class TorrentManager {
  private client: WtClient | null = null;
  private clientPromise: Promise<WtClient> | null = null;
  private active = new Map<string, Active>();
  private starting = new Set<string>();
  private inflightMeta = new Map<string, Promise<{ meta: TorrentMeta; buf: Buffer }>>();
  private locks = new Map<string, Promise<unknown>>();
  private initPromise: Promise<void> | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastStorageCheck = 0;
  private limits = { down: NaN, up: NaN };
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private shuttingDown = false;

  constructor(private opts: TorrentManagerOptions = {}) {}

  // ------------------------------------------------------------------ lifecycle

  init(): Promise<void> {
    return (this.initPromise ??= this.doInit().catch((e) => {
      this.initPromise = null;
      throw e;
    }));
  }

  private async doInit() {
    this.shuttingDown = false;
    await mkdir(paths.torrents, { recursive: true });
    // Anything that was running when the process stopped is queued again; interrupted imports are retried.
    await db.download.updateMany({ where: { status: { in: ["metadata", "downloading", "seeding"] } }, data: { status: "queued" } });
    const interrupted = await db.download.findMany({ where: { status: "importing" }, select: { id: true } });
    if (interrupted.length) await db.download.updateMany({ where: { status: "importing" }, data: { status: "completed" } });
    await this.getClient();
    await this.applyLimits();
    this.tickTimer = setInterval(() => void this.tick(), 1000);
    this.tickTimer.unref?.();
    await this.pump();
    const s = await getSettings();
    if (s.autoImportDownloads) for (const r of interrupted) void this.runImport(r.id);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const a of [...this.active.values()]) {
      await this.persist(a).catch(() => {});
      await this.destroyTorrent(a.torrent);
    }
    this.active.clear();
    const c = this.client;
    this.client = null;
    this.clientPromise = null;
    this.initPromise = null;
    if (c && !c.destroyed) await new Promise<void>((r) => c.destroy(() => r()));
  }

  private getClient(): Promise<WtClient> {
    if (this.client && !this.client.destroyed) return Promise.resolve(this.client);
    return (this.clientPromise ??= (async () => {
      const { default: WebTorrent } = (await import("webtorrent")) as unknown as { default: new (o: Record<string, unknown>) => WtClient };
      const client = new WebTorrent({
        utp: false, // the native uTP addon is fragile in containers; TCP + web seeds are enough
        torrentPort: Number(process.env.TORRENT_PORT) || 0,
        dhtPort: Number(process.env.TORRENT_DHT_PORT) || 0,
        dht: true,
        tracker: {},
        lsd: false,
        natUpnp: false,
        natPmp: false,
        webSeeds: true,
        maxConns: 80,
        ...this.opts.clientOptions,
      });
      client.on("error", (err: unknown) => console.error("[torrents] client error:", errMsg(err)));
      this.client = client;
      this.clientPromise = null;
      this.limits = { down: NaN, up: NaN };
      return client;
    })());
  }

  private async applyLimits() {
    const s = await getSettings();
    const down = s.downloadLimitKBps > 0 ? Math.round(s.downloadLimitKBps * 1024) : -1;
    const up = s.uploadLimitKBps > 0 ? Math.round(s.uploadLimitKBps * 1024) : -1;
    const c = this.client;
    if (!c || c.destroyed) return;
    if (down !== this.limits.down) c.throttleDownload(down);
    if (up !== this.limits.up) c.throttleUpload(up);
    this.limits = { down, up };
  }

  /** Serialize operations per download id. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  // ------------------------------------------------------------------ metadata

  private async resolveMeta(input: { magnet?: string; torrentFile?: Buffer }, timeoutMs: number): Promise<{ meta: TorrentMeta; buf: Buffer; magnet?: string }> {
    if (input.torrentFile && input.torrentFile.length) {
      if (input.torrentFile.length > 10 * 1024 * 1024) throw new TorrentError("Torrent file is too large", 413);
      try {
        return { meta: parseTorrentFile(input.torrentFile), buf: input.torrentFile };
      } catch (e) {
        throw new TorrentError(`Invalid torrent file: ${errMsg(e)}`, 400);
      }
    }
    const magnet = input.magnet?.trim();
    if (!magnet) throw new TorrentError("A magnet link or a .torrent file is required", 400);
    const parsed = parseMagnet(magnet);
    if (!parsed) throw new TorrentError("Invalid magnet link (no BitTorrent info hash)", 400);
    const normalized = /^magnet:/i.test(magnet) ? magnet : buildMagnet(parsed.infoHash);

    // Already known locally? (stored .torrent or a running torrent with metadata)
    const stored = path.join(paths.torrents, `${parsed.infoHash}.torrent`);
    if (existsSync(stored)) {
      try {
        const buf = await readFile(stored);
        return { meta: parseTorrentFile(buf), buf, magnet: normalized };
      } catch { /* fall through and refetch */ }
    }
    const running = this.client?.torrents.find((t) => t.infoHash === parsed.infoHash && t.torrentFile && !t.destroyed);
    if (running?.torrentFile) {
      const buf = Buffer.from(running.torrentFile);
      return { meta: parseTorrentFile(buf), buf, magnet: normalized };
    }

    let p = this.inflightMeta.get(parsed.infoHash);
    if (!p) {
      p = this.fetchMagnetMetadata(normalized, parsed.infoHash, timeoutMs).finally(() => this.inflightMeta.delete(parsed.infoHash));
      this.inflightMeta.set(parsed.infoHash, p);
    }
    const r = await p;
    return { ...r, magnet: normalized };
  }

  /** Join the swarm only long enough to receive the info dictionary, then drop the torrent (nothing is written). */
  private async fetchMagnetMetadata(magnet: string, infoHash: string, timeoutMs: number): Promise<{ meta: TorrentMeta; buf: Buffer }> {
    const client = await this.getClient();
    const tmp = path.join(os.tmpdir(), "rift-torrent-metadata");
    return new Promise((resolve, reject) => {
      let torrent: WtTorrent | undefined;
      let settled = false;
      const finish = (err: Error | null, value?: { meta: TorrentMeta; buf: Buffer }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void this.destroyTorrent(torrent);
        if (err) reject(err);
        else resolve(value!);
      };
      const timer = setTimeout(
        () => finish(new TorrentError(`Could not fetch the torrent metadata within ${Math.round(timeoutMs / 1000)} s (no reachable peers?)`, 504)),
        timeoutMs,
      );
      try {
        torrent = client.add(magnet, { path: tmp, deselect: true, destroyStoreOnDestroy: false });
      } catch (e) {
        clearTimeout(timer);
        return reject(new TorrentError(`Invalid magnet link: ${errMsg(e)}`, 400));
      }
      const t = torrent;
      t.on("error", (e: unknown) => finish(new TorrentError(`Torrent error: ${errMsg(e)}`, 400)));
      t.on("warning", () => {});
      t.once("metadata", () => {
        try {
          const buf = Buffer.from(t.torrentFile!);
          const meta = parseTorrentFile(buf);
          if (meta.infoHash !== infoHash) throw new Error("metadata does not match the info hash");
          finish(null, { meta, buf });
        } catch (e) {
          finish(new TorrentError(`Invalid torrent metadata: ${errMsg(e)}`, 422));
        }
      });
    });
  }

  private destroyTorrent(t: WtTorrent | undefined, destroyStore = false): Promise<void> {
    if (!t || t.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        t.destroy({ destroyStore }, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  async previewMetadata(input: { magnet?: string; torrentFile?: Buffer }): Promise<TorrentPreview> {
    const { meta } = await this.resolveMeta(input, METADATA_TIMEOUT_PREVIEW);
    return { infoHash: meta.infoHash, name: meta.name, totalSize: meta.totalSize, files: meta.files.map((f) => ({ ...f })) };
  }

  // ------------------------------------------------------------------ storage

  /** Bytes still to be downloaded for all unfinished downloads (excluding `exceptId`). */
  private async pendingBytes(exceptId?: string): Promise<number> {
    const rows = await db.download.findMany({ where: { status: { in: ["queued", "metadata", "downloading", "paused"] } } });
    let total = 0;
    for (const r of rows) {
      if (r.id === exceptId) continue;
      const a = this.active.get(r.id);
      const size = a ? this.liveNumbers(a).size : Number(r.size);
      const done = a ? this.liveNumbers(a).downloaded : Number(r.downloaded);
      total += Math.max(0, size - done);
    }
    return total;
  }

  private async checkCanStore(additionalBytes: number, exceptId?: string) {
    const s = await getSettings();
    await mkdir(s.downloadDir, { recursive: true });
    const pending = (await this.pendingBytes(exceptId)) + additionalBytes;
    const free = await freeBytes(s.downloadDir);
    if (free !== null && pending + MIN_FREE_BYTES > free) {
      throw new TorrentError(`Not enough free disk space: ${formatBytes(pending)} needed, ${formatBytes(free)} free`, 507);
    }
    if (s.storageLimitGB > 0) {
      const limit = s.storageLimitGB * GiB;
      const used = await dirUsageBytes(s.downloadDir);
      if (used + pending > limit) {
        throw new TorrentError(
          `Storage limit of ${s.storageLimitGB} GB would be exceeded: ${formatBytes(used)} used, ${formatBytes(pending)} more needed`,
          507,
        );
      }
    }
  }

  /** Periodic enforcement: pause running downloads when the limit or the disk is full. */
  private async enforceStorage() {
    if (!this.active.size) return;
    const s = await getSettings();
    let reason: string | null = null;
    if (s.storageLimitGB > 0) {
      const used = await dirUsageBytes(s.downloadDir);
      if (used > s.storageLimitGB * GiB) reason = `Storage limit of ${s.storageLimitGB} GB reached (${formatBytes(used)} used). Free some space or raise the limit, then resume.`;
    }
    if (!reason) {
      const free = await freeBytes(s.downloadDir);
      if (free !== null && free < MIN_FREE_BYTES) reason = `Disk almost full (${formatBytes(free)} free). Free some space, then resume.`;
    }
    if (!reason) return;
    for (const a of [...this.active.values()]) {
      if (a.finishing) continue;
      await this.withLock(a.id, () => this.stopActive(a.id, "error", reason));
    }
  }

  // ------------------------------------------------------------------ public API

  async add(input: AddTorrentInput): Promise<DownloadView> {
    await this.init();
    const s = await getSettings();
    const { meta, buf, magnet } = await this.resolveMeta(input, METADATA_TIMEOUT_ADD);

    const existing = await db.download.findUnique({ where: { infoHash: meta.infoHash } });
    if (existing) return this.view(existing);

    const valid = new Set(meta.files.map((f) => f.index));
    let selected: number[] | null = null;
    if (input.selectedFiles) {
      selected = [...new Set(input.selectedFiles)].filter((i) => valid.has(i)).sort((a, b) => a - b);
      if (!selected.length) throw new TorrentError("Select at least one file to download", 400);
      if (selected.length === meta.files.length) selected = null;
    }
    const selSet = selected ? new Set(selected) : null;
    const wanted = meta.files.filter((f) => !selSet || selSet.has(f.index));
    const wantedBytes = wanted.reduce((n, f) => n + f.size, 0);

    // Subtract what is already on disk (re-adding a torrent whose data exists).
    let present = 0;
    for (const f of wanted) {
      try {
        const st = await stat(path.join(s.downloadDir, f.path));
        present += Math.min(f.size, st.blocks * 512);
      } catch { /* not there */ }
    }
    await this.checkCanStore(Math.max(0, wantedBytes - present));

    await mkdir(paths.torrents, { recursive: true });
    const torrentPath = path.join(paths.torrents, `${meta.infoHash}.torrent`);
    await writeFile(torrentPath, buf);

    let row: Download;
    try {
      row = await db.download.create({
        data: {
          infoHash: meta.infoHash,
          name: meta.name,
          magnet: magnet ?? buildMagnet(meta.infoHash, meta.name),
          torrentPath,
          status: "queued",
          size: BigInt(wantedBytes),
          downloaded: BigInt(0),
          progress: 0,
          savePath: path.join(s.downloadDir, safePathSegment(meta.name)),
          selectedFiles: selected ? JSON.stringify(selected) : null,
          files: JSON.stringify(meta.files.map((f) => ({ ...f, progress: 0 }))),
          tmdbId: input.tmdbId ?? null,
          mediaType: input.mediaType ?? null,
          season: input.season ?? null,
          createdBy: input.createdBy ?? null,
        },
      });
    } catch (e) {
      const dup = await db.download.findUnique({ where: { infoHash: meta.infoHash } });
      if (dup) return this.view(dup);
      throw e;
    }
    await this.pump();
    const fresh = await db.download.findUnique({ where: { id: row.id } });
    return this.view(fresh ?? row);
  }

  async pause(id: string): Promise<DownloadView> {
    await this.init();
    await this.withLock(id, async () => {
      const row = await this.requireRow(id);
      if (this.active.has(id)) await this.stopActive(id, "paused", null);
      else if (row.status === "queued" || row.status === "error") await db.download.update({ where: { id }, data: { status: "paused" } });
      else if (row.status !== "paused") throw new TorrentError(`Cannot pause a download that is ${row.status}`, 409);
    });
    await this.pump();
    return this.view(await this.requireRow(id));
  }

  async resume(id: string): Promise<DownloadView> {
    await this.init();
    await this.withLock(id, async () => {
      const row = await this.requireRow(id);
      if (this.active.has(id) || row.status === "queued") return;
      if (row.status === "importing") throw new TorrentError("The download is being imported", 409);
      if (row.status === "imported" || row.status === "completed") {
        throw new TorrentError("The download is already complete", 409);
      }
      // paused | error — check room for what is left before restarting
      await this.checkCanStore(Math.max(0, Number(row.size) - Number(row.downloaded)), id);
      await db.download.update({ where: { id }, data: { status: "queued", error: null } });
    });
    await this.pump();
    return this.view(await this.requireRow(id));
  }

  async remove(id: string, opts: { deleteFiles: boolean }): Promise<void> {
    await this.init();
    await this.withLock(id, async () => {
      const row = await this.requireRow(id);
      const a = this.active.get(id);
      if (a) {
        this.active.delete(id);
        await this.destroyTorrent(a.torrent);
      }
      if (opts.deleteFiles) {
        const base = path.dirname(row.savePath);
        const files = jsonParse<StoredFile[]>(row.files, []);
        const deleted: string[] = [];
        for (const f of files) {
          const abs = path.resolve(base, f.path);
          if (!abs.startsWith(path.resolve(base) + path.sep)) continue; // never leave the download dir
          try {
            await unlink(abs);
            deleted.push(abs);
          } catch { /* already gone */ }
        }
        // prune now-empty directories inside the torrent's folder
        const dirs = [...new Set(files.map((f) => path.dirname(path.resolve(base, f.path))))].sort((x, y) => y.length - x.length);
        for (const d of dirs) {
          let cur = d;
          while (cur.startsWith(path.resolve(base) + path.sep)) {
            try {
              await rmdir(cur);
            } catch {
              break;
            }
            cur = path.dirname(cur);
          }
        }
        if (deleted.length) await db.mediaFile.updateMany({ where: { path: { in: deleted } }, data: { status: "missing" } }).catch(() => {});
      }
      if (row.torrentPath) await rm(row.torrentPath, { force: true }).catch(() => {});
      await db.download.delete({ where: { id } }).catch(() => {});
    });
    await this.pump();
  }

  async setSelectedFiles(id: string, indexes: number[]): Promise<DownloadView> {
    await this.init();
    await this.withLock(id, async () => {
      const row = await this.requireRow(id);
      const files = jsonParse<StoredFile[]>(row.files, []);
      if (!files.length) throw new TorrentError("File list is not known yet (waiting for metadata)", 409);
      if (row.status === "importing") throw new TorrentError("The download is being imported", 409);
      const valid = new Set(files.map((f) => f.index));
      let selected: number[] | null = [...new Set(indexes)].filter((i) => valid.has(i)).sort((a, b) => a - b);
      if (!selected.length) throw new TorrentError("Select at least one file to download", 400);
      if (selected.length === files.length) selected = null;
      const sel = selected ? new Set(selected) : null;
      const prevSel = jsonParse<number[] | null>(row.selectedFiles, null);
      const prevSet = prevSel ? new Set(prevSel) : null;
      const size = files.filter((f) => !sel || sel.has(f.index)).reduce((n, f) => n + f.size, 0);
      const added = files.filter((f) => (!sel || sel.has(f.index)) && prevSet && !prevSet.has(f.index) && (f.progress ?? 0) < 1);
      const addedBytes = added.reduce((n, f) => n + f.size * (1 - (f.progress ?? 0)), 0);
      if (addedBytes > 0) await this.checkCanStore(addedBytes, id);

      const data: Record<string, unknown> = { selectedFiles: selected ? JSON.stringify(selected) : null, size: BigInt(size) };
      const a = this.active.get(id);
      if (a) {
        a.selected = selected;
        this.applySelection(a);
      } else if (added.length && (row.status === "completed" || row.status === "imported" || row.status === "error")) {
        // newly selected files on a finished download: fetch them
        data.status = "queued";
        data.error = null;
        data.completedAt = null;
      }
      await db.download.update({ where: { id }, data });
      if (a) await this.persist(a);
    });
    await this.pump();
    return this.view(await this.requireRow(id));
  }

  async list(): Promise<DownloadView[]> {
    await this.init();
    const rows = await db.download.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map((r) => this.view(r));
  }

  async get(id: string): Promise<DownloadView | null> {
    await this.init();
    const row = await db.download.findUnique({ where: { id } });
    return row ? this.view(row) : null;
  }

  // ------------------------------------------------------------------ internals

  private async requireRow(id: string): Promise<Download> {
    const row = await db.download.findUnique({ where: { id } });
    if (!row) throw new TorrentError("Download not found", 404);
    return row;
  }

  /** Start queued downloads while slots are free. Never starts anything that was not explicitly added. */
  private pump(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false;
        const s = await getSettings();
        const max = Math.max(1, Math.floor(s.maxActiveDownloads || 1));
        const free = max - this.active.size - this.starting.size;
        if (free <= 0) continue;
        const queued = await db.download.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, take: free });
        for (const row of queued) {
          if (this.active.has(row.id) || this.starting.has(row.id)) continue;
          this.starting.add(row.id);
          try {
            await this.withLock(row.id, () => this.start(row.id));
          } catch (e) {
            console.error(`[torrents] failed to start ${row.name}:`, errMsg(e));
            await db.download.update({ where: { id: row.id }, data: { status: "error", error: `Could not start: ${errMsg(e)}` } }).catch(() => {});
          } finally {
            this.starting.delete(row.id);
          }
        }
      } while (this.pumpAgain && !this.shuttingDown);
    })().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async start(id: string) {
    const row = await db.download.findUnique({ where: { id } });
    if (!row || row.status !== "queued" || this.active.has(id)) return;
    const client = await this.getClient();
    await this.applyLimits();
    let source: string | Buffer | null = null;
    if (row.torrentPath && existsSync(row.torrentPath)) source = await readFile(row.torrentPath).catch(() => null);
    if (!source) source = row.magnet ?? buildMagnet(row.infoHash, row.name);
    const base = path.dirname(row.savePath);
    await mkdir(base, { recursive: true });

    // a leftover torrent with the same hash (metadata preview) would make webtorrent reject the add
    const dup = client.torrents.find((t) => t.infoHash === row.infoHash);
    if (dup) await this.destroyTorrent(dup);

    const hasMeta = typeof source !== "string";
    await db.download.update({ where: { id }, data: { status: hasMeta ? "downloading" : "metadata", error: null } });

    // NOTE: no awaits between add() and attaching listeners, or early events (metadata of a .torrent) are missed.
    const torrent = client.add(typeof source === "string" ? source : new Uint8Array(source), { path: base, deselect: true });
    const storedFiles = jsonParse<StoredFile[]>(row.files, []);
    const a: Active = {
      id, infoHash: row.infoHash, torrent, selected: jsonParse<number[] | null>(row.selectedFiles, null), lastPersist: 0, finishing: false,
      files: storedFiles.length ? storedFiles.map(({ index, path: p, size }) => ({ index, path: p, size })) : null,
    };
    this.active.set(id, a);
    torrent.on("error", (e: unknown) => void this.onTorrentError(a, e));
    torrent.on("warning", () => { /* tracker / peer warnings are normal; DHT and other trackers keep working */ });
    torrent.once("metadata", () => void this.onMetadata(a));
    torrent.once("ready", () => this.checkFinished(a));
    torrent.on("done", () => this.checkFinished(a));
    let verifyQueued = false;
    torrent.on("verified", () => {
      if (verifyQueued) return;
      verifyQueued = true;
      setTimeout(() => {
        verifyQueued = false;
        this.checkFinished(a);
      }, 250).unref?.();
    });
  }

  private async onMetadata(a: Active) {
    if (this.active.get(a.id) !== a) return;
    const t = a.torrent;
    try {
      // validate (path traversal etc.) BEFORE selecting anything: with `deselect: true` nothing is requested yet
      const buf = Buffer.from(t.torrentFile!);
      const meta = parseTorrentFile(buf);
      a.files = meta.files;
      this.applySelection(a);
      const torrentPath = path.join(paths.torrents, `${meta.infoHash}.torrent`);
      if (!existsSync(torrentPath)) await writeFile(torrentPath, buf);
      const row = await db.download.findUnique({ where: { id: a.id } });
      const data: Record<string, unknown> = { status: "downloading", torrentPath, name: meta.name };
      if (!row?.files) data.files = JSON.stringify(meta.files.map((f) => ({ ...f, progress: 0 })));
      await db.download.update({ where: { id: a.id }, data });
    } catch (e) {
      // unsafe / unparsable metadata: stop and report
      await this.withLock(a.id, () => this.stopActive(a.id, "error", `Invalid torrent metadata: ${errMsg(e)}`));
      void this.pump();
    }
  }

  private applySelection(a: Active) {
    const t = a.torrent;
    if (!t.files?.length || t.destroyed) return;
    if (t.pieces.length) t.deselect(0, t.pieces.length - 1);
    for (const f of this.selectedFiles(a)) f.select();
  }

  private selectedFiles(a: Active): WtFile[] {
    const files = a.torrent.files ?? [];
    // default = every real file (BEP 47 padding files excluded when our own parser knows the list)
    const idx = a.selected ?? a.files?.map((f) => f.index);
    if (!idx) return files;
    return idx.map((i) => files[i]).filter(Boolean);
  }

  private liveNumbers(a: Active) {
    const t = a.torrent;
    const sel = this.selectedFiles(a);
    let size = 0;
    let downloaded = 0;
    for (const f of sel) {
      size += f.length;
      downloaded += Math.min(f.length, f.done ? f.length : f.downloaded);
    }
    const downloadSpeed = t.destroyed ? 0 : Math.round(t.downloadSpeed || 0);
    const uploadSpeed = t.destroyed ? 0 : Math.round(t.uploadSpeed || 0);
    const ratio = t.received || size ? (t.uploaded || 0) / (t.received || size) : 0;
    return { size, downloaded, downloadSpeed, uploadSpeed, peers: t.destroyed ? 0 : t.numPeers || 0, ratio };
  }

  private checkFinished(a: Active) {
    if (a.finishing || this.active.get(a.id) !== a) return;
    const t = a.torrent;
    if (!t.ready || t.destroyed || !t.files?.length) return;
    const sel = this.selectedFiles(a);
    if (!sel.length || !sel.every((f) => f.done || f.length === 0 || f.progress >= 1)) return;
    a.finishing = true;
    void this.withLock(a.id, () => this.finish(a)).then(() => this.pump());
  }

  private async finish(a: Active) {
    if (this.active.get(a.id) !== a) return;
    await this.persist(a, { status: "completed", completedAt: new Date(), progress: 1, error: null });
    this.active.delete(a.id);
    // We stop after completion: no background seeding so the box never uploads/downloads anything unasked.
    await this.destroyTorrent(a.torrent);
    const s = await getSettings();
    if (s.autoImportDownloads) void this.runImport(a.id);
  }

  private async runImport(id: string) {
    await this.withLock(id, async () => {
      const row = await db.download.findUnique({ where: { id } });
      if (!row || row.status !== "completed") return;
      await db.download.update({ where: { id }, data: { status: "importing" } });
      try {
        await importDownload(id);
        await db.download.update({ where: { id }, data: { status: "imported", importedAt: new Date(), error: null } }).catch(() => {});
      } catch (e) {
        console.error(`[torrents] import of ${row.name} failed:`, errMsg(e));
        await db.download.update({ where: { id }, data: { status: "error", error: `Import failed: ${errMsg(e)} (files were kept)` } }).catch(() => {});
      }
    });
  }

  /** Manually (re)run the library import for a completed download. */
  async importNow(id: string): Promise<DownloadView> {
    await this.init();
    const row = await this.requireRow(id);
    if (this.active.has(id)) throw new TorrentError("The download is still running", 409);
    if (row.progress < 1 && row.status !== "completed" && row.status !== "imported") throw new TorrentError("The download is not complete", 409);
    if (row.status !== "completed") await db.download.update({ where: { id }, data: { status: "completed", error: null } });
    await this.runImport(id);
    return this.view(await this.requireRow(id));
  }

  private async onTorrentError(a: Active, e: unknown) {
    if (this.active.get(a.id) !== a) return;
    console.error(`[torrents] ${a.infoHash} error:`, errMsg(e));
    await this.withLock(a.id, () => this.stopActive(a.id, "error", errMsg(e)));
    void this.pump();
  }

  /** Remove a running torrent from the client (keeping its data) and persist the given status. */
  private async stopActive(id: string, status: "paused" | "error" | "queued", error: string | null) {
    const a = this.active.get(id);
    if (!a) {
      await db.download.update({ where: { id }, data: { status, error } }).catch(() => {});
      return;
    }
    await this.persist(a, { status, error });
    this.active.delete(id);
    await this.destroyTorrent(a.torrent);
  }

  private async persist(a: Active, extra: Record<string, unknown> = {}) {
    a.lastPersist = Date.now();
    const data: Record<string, unknown> = { ...extra };
    const t = a.torrent;
    if (t.files?.length) {
      const live = this.liveNumbers(a);
      const entries = a.files ?? t.files.map((f, index) => ({ index, path: f.path, size: f.length }));
      data.files = JSON.stringify(
        entries.map((f) => {
          const wf = t.files[f.index];
          return { index: f.index, path: f.path, size: f.size, progress: wf ? (wf.done || wf.length === 0 ? 1 : Math.min(1, wf.progress)) : 0 };
        }),
      );
      data.size = BigInt(live.size);
      data.downloaded = BigInt(Math.round(live.downloaded));
      if (extra.progress === undefined) data.progress = live.size ? Math.min(1, live.downloaded / live.size) : 0;
    }
    await db.download.update({ where: { id: a.id }, data }).catch(() => {});
  }

  private async tick() {
    if (this.shuttingDown) return;
    try {
      await this.applyLimits();
      const now = Date.now();
      for (const a of this.active.values()) {
        this.checkFinished(a);
        if (!a.finishing && now - a.lastPersist >= PERSIST_EVERY) void this.persist(a);
      }
      if (now - this.lastStorageCheck >= STORAGE_CHECK_EVERY) {
        this.lastStorageCheck = now;
        await this.enforceStorage();
      }
      // pick up queued rows (e.g. after a slot freed or settings changed)
      if (!this.pumping) await this.pump();
    } catch (e) {
      console.error("[torrents] tick failed:", errMsg(e));
    }
  }

  private view(row: Download): DownloadView {
    const a = this.active.get(row.id);
    const stored = jsonParse<StoredFile[]>(row.files, []);
    const selArr = a ? a.selected : jsonParse<number[] | null>(row.selectedFiles, null);
    const sel = selArr ? new Set(selArr) : null;
    const finished = row.status === "completed" || row.status === "importing" || row.status === "imported";
    let size = Number(row.size);
    let downloaded = Number(row.downloaded);
    let progress = row.progress;
    let downloadSpeed = 0;
    let uploadSpeed = 0;
    let peers = 0;
    let ratio = 0;
    const live = a && !a.torrent.destroyed && a.torrent.files?.length ? this.liveNumbers(a) : null;
    if (a && !a.torrent.destroyed) {
      downloadSpeed = Math.round(a.torrent.downloadSpeed || 0);
      uploadSpeed = Math.round(a.torrent.uploadSpeed || 0);
      peers = a.torrent.numPeers || 0;
    }
    if (live) {
      size = live.size;
      downloaded = live.downloaded;
      progress = size ? Math.min(1, downloaded / size) : 0;
      ratio = live.ratio;
    }
    const files: DownloadFileView[] = stored.map((f) => {
      const selected = !sel || sel.has(f.index);
      let p = f.progress ?? 0;
      const wf = live ? a!.torrent.files[f.index] : undefined;
      if (wf) p = wf.done || wf.length === 0 ? 1 : Math.min(1, wf.progress);
      else if (finished && selected) p = 1;
      return { index: f.index, path: f.path, size: f.size, selected, progress: p };
    });
    const remaining = Math.max(0, size - downloaded);
    const eta = live && downloadSpeed > 0 && remaining > 0 ? Math.round(remaining / downloadSpeed) : remaining === 0 && live ? 0 : null;
    return {
      id: row.id,
      infoHash: row.infoHash,
      name: row.name,
      status: (a ? (live ? "downloading" : "metadata") : row.status) as DownloadStatus,
      progress: finished ? 1 : progress,
      size,
      downloaded: finished ? size : downloaded,
      downloadSpeed,
      uploadSpeed,
      peers,
      ratio,
      eta,
      files,
      error: row.error,
      tmdbId: row.tmdbId,
      mediaType: (row.mediaType as "movie" | "tv" | null) ?? null,
      season: row.season,
      savePath: row.savePath,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  /** Test/diagnostic hook: connect a running download directly to a peer ("host:port"). */
  addPeer(id: string, peer: string): boolean {
    const a = this.active.get(id);
    return a ? a.torrent.addPeer(peer) : false;
  }

  /** True while the download is attached to the BitTorrent client. */
  isActive(id: string): boolean {
    return this.active.has(id);
  }
}

const g = globalThis as unknown as { __riftTorrentManager?: TorrentManager };

/** Process-wide singleton (survives Next dev HMR). */
export function getTorrentManager(): TorrentManager {
  return (g.__riftTorrentManager ??= new TorrentManager());
}
