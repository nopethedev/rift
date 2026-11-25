// Searches and lookups (Lavalink loadtracks, yt-dlp searches, resolved recordings) kept in memory and in a JSON file,
// so a song asked for again (or after a restart) doesn't hit the source again. Some Lavalink nodes rate-limit hard.
// When the live call fails, an older copy (up to `staleMs`) is used instead of the error.
import fs from "node:fs";
import path from "node:path";

interface Hit { at: number; v: unknown }

export interface WrapOpts<T> {
  /** false = don't store this answer (errors are never stored). */
  keep?: (v: T) => boolean;
  /** A different lifetime for some answers (e.g. "nothing found"). */
  ttlFor?: (v: T) => number;
  /** How old a copy may be when the live call fails (default 3 days). 0 = never. */
  staleMs?: number;
}

export class LookupCache {
  private mem = new Map<string, Hit>();
  private inflight = new Map<string, Promise<unknown>>();
  private file: string | null = null;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly max = 2500, private readonly flushMs = 20_000) {}

  /** Start persisting to `file` (loads what's there). */
  attach(file: string) {
    if (this.file === file) return;
    if (this.file) { this.flush(); this.mem.clear(); } // another cache folder: its own lookups
    this.file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as [string, Hit][];
      const now = Date.now();
      for (const [k, h] of raw) if (h && typeof h.at === "number" && now - h.at < 30 * 86400_000 && !this.mem.has(k)) this.mem.set(k, h);
      this.trim();
    } catch { /* first run / unreadable: start empty */ }
  }

  get size() { return this.mem.size; }

  peek<T>(key: string): { v: T; at: number } | undefined {
    const h = this.mem.get(key);
    return h ? { v: h.v as T, at: h.at } : undefined;
  }

  set(key: string, v: unknown) {
    this.mem.delete(key);
    this.mem.set(key, { at: Date.now(), v });
    this.trim();
    this.touch();
  }

  delete(key: string) {
    if (this.mem.delete(key)) this.touch();
  }

  /** Drop every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string) {
    for (const k of [...this.mem.keys()]) if (k.startsWith(prefix)) this.mem.delete(k);
    this.touch();
  }

  clear() { this.mem.clear(); this.inflight.clear(); this.touch(); }

  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>, o: WrapOpts<T> = {}): Promise<T> {
    const hit = this.mem.get(key);
    if (hit && Date.now() - hit.at < (o.ttlFor ? o.ttlFor(hit.v as T) : ttlMs)) {
      this.mem.delete(key); this.mem.set(key, hit); // recently used stays
      return hit.v as T;
    }
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().then(
        (v) => { if (!o.keep || o.keep(v)) this.set(key, v); return v; },
        (e) => { if (hit && Date.now() - hit.at < (o.staleMs ?? 3 * 86400_000)) return hit.v as T; throw e; },
      ).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Write the file now (shutdown). */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.mem.entries()]));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.warn("[music] could not save the lookup cache:", (e as Error).message); }
  }

  private trim() {
    while (this.mem.size > this.max) this.mem.delete(this.mem.keys().next().value!);
  }

  private touch() {
    this.dirty = true;
    if (this.file && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushMs); this.timer.unref(); }
  }
}

/** One per worker process. */
export const lookups = new LookupCache();
