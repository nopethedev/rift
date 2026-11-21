import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { getSettings } from "../settings";
import { probeFile, type ProbeResult } from "@shared/probe";
import { TorrentError } from "./errors";
import { parseMagnet, parseTorrentFile } from "./metainfo";
import { freeBytes } from "./storage";
import { isVideoFile } from "../library/filename";

/**
 * On-demand torrent streaming.
 *
 * Lifecycle: add torrent -> fetch metadata -> pick the video file -> make the first/last few MB "critical" (pre-buffer)
 * -> probe the container headers -> `ready` (player starts). While playing, HTTP range requests are served straight from the
 * torrent with a sliding critical read-ahead window. The player sends a heartbeat; a session with no activity for
 * STREAM_IDLE_SECONDS (default 60) is destroyed and its files are deleted. Nothing is added to the library.
 */

export type StreamStatus = "metadata" | "choose" | "buffering" | "ready" | "error";

export interface StreamView {
  id: string;
  infoHash: string;
  name: string;
  status: StreamStatus;
  error?: string | null;
  files: { index: number; path: string; size: number; video: boolean }[];
  fileIndex: number | null;
  fileName: string | null;
  fileSize: number;
  /** 0..1 progress of the initial pre-buffer (head + tail of the file). */
  prebuffer: number;
  /** 0..1 of the selected file downloaded so far. */
  progress: number;
  downloaded: number;
  downloadSpeed: number;
  peers: number;
  idleSeconds: number;
  idleLimit: number;
  createdAt: string;
  probe: { durationSec: number; container: string } | null;
}

interface WtFile { path: string; length: number; offset: number; downloaded: number; _startPiece: number; _endPiece: number; select(p?: number): void; deselect(): void; createReadStream(o?: { start?: number; end?: number }): Readable }
interface WtTorrent {
  infoHash: string; name: string; files: WtFile[]; pieceLength: number; lastPieceLength: number; length: number; destroyed: boolean;
  bitfield?: { get(i: number): boolean }; downloadSpeed: number; numPeers: number; downloaded: number;
  torrentFile?: Uint8Array;
  critical(start: number, end: number): void; select(a: number, b: number, p?: number): void; deselect(a: number, b: number): void;
  on(ev: string, fn: (...a: any[]) => void): void; once(ev: string, fn: (...a: any[]) => void): void;
  destroy(o?: { destroyStore?: boolean }, cb?: () => void): void;
}
interface WtClient { add(id: string | Uint8Array, o?: Record<string, unknown>): WtTorrent; on(ev: string, fn: (...a: any[]) => void): void; destroy(cb?: () => void): void; destroyed: boolean }

interface Session {
  id: string;
  infoHash: string;
  dir: string;
  torrent: WtTorrent;
  status: StreamStatus;
  error: string | null;
  file: WtFile | null;
  fileIndex: number | null;
  fileList: StreamView["files"];
  preHead: [number, number] | null;
  preTail: [number, number] | null;
  prebuffer: number;
  lastActivity: number;
  createdAt: number;
  probe: ProbeResult | null;
  ticker: ReturnType<typeof setInterval> | null;
  tailRetried?: boolean;
}

/** Public trackers appended to every stream to find peers faster. */
const EXTRA_TRACKERS = [
  "udp://tracker.opentrackers.org:8191/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "https://tracker.tamersunion.org:443/announce",
];

const IDLE_SECONDS = Math.max(15, Number(process.env.STREAM_IDLE_SECONDS) || 60);
const MAX_SESSIONS = Math.max(1, Number(process.env.STREAM_MAX_SESSIONS) || 3);
const PREBUFFER_BYTES = Math.max(1, Number(process.env.STREAM_PREBUFFER_MB) || 8) * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const READAHEAD_BYTES = 24 * 1024 * 1024;
const METADATA_TIMEOUT = 60_000;
const MIN_FREE = 512 * 1024 * 1024;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class TorrentStreamer {
  private sessions = new Map<string, Session>();
  private client: WtClient | null = null;
  private clientPromise: Promise<WtClient> | null = null;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private cleaned = false;

  private async root() {
    const s = await getSettings();
    return path.join(s.downloadDir, ".stream-cache"); // dot folder: ignored by the library scanner
  }

  private async getClient(): Promise<WtClient> {
    if (this.client && !this.client.destroyed) return this.client;
    return (this.clientPromise ??= (async () => {
      const { default: WebTorrent } = (await import("webtorrent")) as unknown as { default: new (o: Record<string, unknown>) => WtClient };
      const c = new WebTorrent({ utp: false, dht: true, tracker: {}, lsd: false, natUpnp: false, natPmp: false, webSeeds: true, maxConns: 200, torrentPort: 0, dhtPort: 0 });
      c.on("error", (e: unknown) => console.error("[stream] client error:", errMsg(e)));
      this.client = c;
      this.clientPromise = null;
      return c;
    })());
  }

  /** Delete leftovers of previous runs and start the idle reaper (idempotent; also called at boot). */
  async init() {
    await this.ensureStarted();
  }

  private async ensureStarted() {
    if (!this.reaper) {
      this.reaper = setInterval(() => void this.reap(), 5000);
      this.reaper.unref?.();
    }
    if (this.cleaned) return;
    this.cleaned = true;
    await rm(await this.root(), { recursive: true, force: true }).catch(() => {});
  }

  private async reap() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastActivity > IDLE_SECONDS * 1000) {
        console.log(`[stream] ${s.id} idle for ${IDLE_SECONDS}s, deleting`);
        await this.destroy(s.id);
      }
    }
  }

  private view(s: Session): StreamView {
    const f = s.file;
    return {
      id: s.id,
      infoHash: s.infoHash,
      name: s.torrent.name || "Loading…",
      status: s.status,
      error: s.error,
      files: s.fileList,
      fileIndex: s.fileIndex,
      fileName: f ? path.basename(f.path) : null,
      fileSize: f?.length ?? 0,
      prebuffer: s.prebuffer,
      progress: f && f.length ? Math.min(1, f.downloaded / f.length) : 0,
      downloaded: f?.downloaded ?? 0,
      downloadSpeed: s.torrent.downloadSpeed,
      peers: s.torrent.numPeers,
      idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000),
      idleLimit: IDLE_SECONDS,
      createdAt: new Date(s.createdAt).toISOString(),
      probe: s.probe ? { durationSec: s.probe.durationSec, container: s.probe.container } : null,
    };
  }

  private fail(s: Session, msg: string) {
    s.status = "error";
    s.error = msg;
    if (s.ticker) clearInterval(s.ticker);
    s.ticker = null;
  }

  /** Start streaming a magnet or .torrent. Returns immediately; poll `get()` for progress. */
  async start(input: { magnet?: string; torrentFile?: Buffer; fileIndex?: number }): Promise<StreamView> {
    await this.ensureStarted();
    let infoHash: string;
    let source: string | Uint8Array;
    try {
      if (input.torrentFile) {
        infoHash = parseTorrentFile(input.torrentFile).infoHash;
        source = new Uint8Array(input.torrentFile);
      } else if (input.magnet) {
        const m = parseMagnet(input.magnet);
        if (!m) throw new Error("invalid magnet link");
        infoHash = m.infoHash;
        source = input.magnet;
      } else throw new Error("provide a magnet link or a .torrent file");
    } catch (e) {
      throw new TorrentError(errMsg(e), 400);
    }

    const existing = [...this.sessions.values()].find((s) => s.infoHash === infoHash);
    if (existing) {
      existing.lastActivity = Date.now();
      if (input.fileIndex !== undefined && existing.status === "choose") await this.selectFile(existing.id, input.fileIndex);
      return this.view(existing);
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new TorrentError(`Maximum of ${MAX_SESSIONS} simultaneous streams reached. Stop one first.`, 429);

    const root = await this.root();
    const free = await freeBytes(root);
    if (free !== null && free < MIN_FREE) throw new TorrentError("Not enough free disk space to stream", 507);

    const id = randomBytes(9).toString("base64url");
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    const client = await this.getClient();
    let torrent: WtTorrent;
    try {
      torrent = client.add(source, { path: dir, deselect: true, announce: EXTRA_TRACKERS, destroyStoreOnDestroy: true });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new TorrentError(`Invalid torrent: ${errMsg(e)}`, 400);
    }
    const s: Session = {
      id, infoHash, dir, torrent, status: "metadata", error: null, file: null, fileIndex: null, fileList: [], preHead: null, preTail: null,
      prebuffer: 0, lastActivity: Date.now(), createdAt: Date.now(), probe: null, ticker: null,
    };
    this.sessions.set(id, s);

    const metaTimer = setTimeout(() => {
      if (s.status === "metadata") this.fail(s, "Could not fetch torrent metadata within 60 s (no reachable peers?)");
    }, METADATA_TIMEOUT);
    torrent.on("error", (e: unknown) => { clearTimeout(metaTimer); this.fail(s, `Torrent error: ${errMsg(e)}`); });
    torrent.on("warning", () => {});
    torrent.once("ready", () => {
      clearTimeout(metaTimer);
      try {
        torrent.files.forEach((f) => f.deselect());
        torrent.deselect(0, torrent.files.length ? torrent.files[torrent.files.length - 1]._endPiece : 0);
        s.fileList = torrent.files.map((f, index) => ({ index, path: f.path, size: f.length, video: isVideoFile(f.path) }));
        const vids = s.fileList.filter((f) => f.video).sort((a, b) => b.size - a.size);
        if (!vids.length) return this.fail(s, "This torrent contains no video files");
        const big = vids.filter((v) => v.size > 50 * 1024 * 1024);
        if (input.fileIndex !== undefined) void this.selectFile(id, input.fileIndex).catch((e) => this.fail(s, errMsg(e)));
        else if (big.length > 1) s.status = "choose"; // e.g. a season pack: let the admin pick an episode
        else void this.selectFile(id, vids[0].index).catch((e) => this.fail(s, errMsg(e)));
      } catch (e) {
        this.fail(s, errMsg(e));
      }
    });
    return this.view(s);
  }

  /** Choose the file to stream and begin the pre-buffer. */
  async selectFile(id: string, index: number): Promise<StreamView> {
    const s = this.mustGet(id);
    const f = s.torrent.files[index];
    if (!f || !isVideoFile(f.path)) throw new TorrentError("Not a video file", 400);
    if (s.file) return this.view(s); // already chosen
    const free = await freeBytes(s.dir);
    if (free !== null && f.length + MIN_FREE > free) throw new TorrentError("Not enough free disk space for this file", 507);
    s.file = f;
    s.fileIndex = index;
    s.status = "buffering";
    s.lastActivity = Date.now();

    const t = s.torrent;
    const pl = t.pieceLength;
    const headEnd = Math.min(f._endPiece, f._startPiece + Math.max(1, Math.ceil(Math.min(PREBUFFER_BYTES, Math.max(1.5 * 1024 * 1024, f.length * 0.005), f.length) / pl)));
    const tailStart = Math.max(headEnd + 1, f._endPiece - Math.max(0, Math.ceil(Math.min(TAIL_BYTES, f.length) / pl) - 1));
    s.preHead = [f._startPiece, headEnd];
    s.preTail = tailStart <= f._endPiece ? [tailStart, f._endPiece] : null;

    // Whole file at normal priority (so everything downloads after the playhead), head/tail critical right now.
    // Only head + tail are selected at first (a whole-file selection would be worked through first and starve the tail);
    // the rest of the file is selected once the pre-buffer is complete (see tick()).
    t.select(s.preHead[0], s.preHead[1], 5);
    t.critical(s.preHead[0], s.preHead[1]);
    if (s.preTail) {
      t.select(s.preTail[0], s.preTail[1], 5);
      t.critical(s.preTail[0], s.preTail[1]);
    }

    s.ticker = setInterval(() => void this.tick(s), 400);
    return this.view(s);
  }

  private async tick(s: Session) {
    if (s.status !== "buffering" || !s.preHead || !s.torrent.bitfield) return;
    const bf = s.torrent.bitfield;
    const ranges = [s.preHead, ...(s.preTail ? [s.preTail] : [])];
    let have = 0, total = 0;
    for (const [a, b] of ranges) for (let i = a; i <= b; i++) { total++; if (bf.get(i)) have++; }
    s.prebuffer = total ? have / total : 1;
    if (have < total) return;
    if (s.ticker) clearInterval(s.ticker);
    s.ticker = null;
    try {
      const file = path.join(s.dir, s.file!.path);
      s.probe = await probeFile(file);
      if (!s.probe.streams.some((x) => x.type === "video")) throw new Error("No video stream found");
      s.status = "ready";
      s.prebuffer = 1;
      if (!s.torrent.destroyed) s.file!.select(0); // now fetch the rest at normal priority behind the playhead
    } catch (e) {
      // MP4s with the index (moov) at the end can need more than the initial tail: fetch a bigger one once, then give up.
      const f = s.file!;
      if (!s.tailRetried && s.preTail && !s.torrent.destroyed) {
        s.tailRetried = true;
        const pl = s.torrent.pieceLength;
        const start = Math.max(s.preHead![1] + 1, f._endPiece - Math.ceil((16 * 1024 * 1024) / pl) + 1);
        if (start < s.preTail[0]) {
          s.preTail = [start, f._endPiece];
          s.torrent.select(start, f._endPiece, 5);
          s.torrent.critical(start, f._endPiece);
          s.ticker = setInterval(() => void this.tick(s), 400);
          return;
        }
      }
      this.fail(s, `Could not read the video headers: ${errMsg(e)}`);
    }
  }

  private mustGet(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new TorrentError("Stream not found or expired", 404);
    return s;
  }

  /** Status of a session; counts as activity unless `peek`. */
  get(id: string, opts: { peek?: boolean } = {}): StreamView {
    const s = this.mustGet(id);
    if (!opts.peek) s.lastActivity = Date.now();
    return this.view(s);
  }

  heartbeat(id: string): StreamView {
    return this.get(id);
  }

  list(): StreamView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  probe(id: string): ProbeResult | null {
    return this.mustGet(id).probe;
  }

  /**
   * Byte stream of the selected file for an HTTP range. Waits for pieces as needed (WebTorrent prioritises them) and keeps a
   * critical read-ahead window in front of the reader so playback stays ahead of the download.
   */
  openRange(id: string, start: number, end: number): { chunks: AsyncGenerator<Uint8Array>; size: number } {
    const s = this.mustGet(id);
    if (!s.file || s.status === "error") throw new TorrentError("Stream is not ready", 409);
    s.lastActivity = Date.now();
    const f = s.file;
    const t = s.torrent;
    const pl = t.pieceLength;
    const windowFor = (byte: number) => {
      const a = Math.floor((f.offset + byte) / pl);
      return [a, Math.min(f._endPiece, a + Math.ceil(READAHEAD_BYTES / pl))] as const;
    };
    let [wa, wb] = windowFor(start);
    t.critical(wa, wb);
    const src = f.createReadStream({ start, end });
    let read = start;
    async function* pump(): AsyncGenerator<Uint8Array> {
      try {
          for await (const chunk of src as AsyncIterable<Uint8Array>) {
          read += chunk.length;
          s.lastActivity = Date.now();
          const [a, b] = windowFor(read);
          if (b > wb) { wb = b; if (!t.destroyed) t.critical(a, b); }
          yield chunk;
        }
      } finally {
        src.destroy();
      }
    }
    return { chunks: pump(), size: f.length };
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.ticker) clearInterval(s.ticker);
    await new Promise<void>((r) => {
      try { s.torrent.destroy({ destroyStore: true }, () => r()); } catch { r(); }
      setTimeout(r, 3000);
    });
    const root = await this.root();
    // only ever delete inside our own cache root
    if (s.dir.startsWith(root + path.sep)) await rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  async shutdown() {
    for (const id of [...this.sessions.keys()]) await this.destroy(id);
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    const c = this.client;
    this.client = null;
    if (c && !c.destroyed) await new Promise<void>((r) => c.destroy(() => r()));
  }
}

const g = globalThis as unknown as { __riftStreamer?: TorrentStreamer };
export function getTorrentStreamer(): TorrentStreamer {
  return (g.__riftStreamer ??= new TorrentStreamer());
}
