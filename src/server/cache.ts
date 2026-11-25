import "server-only";
// Two-level cache for answers from rate-limited outside services (Deezer, Lavalink nodes, lyrics, Spotify):
// memory first, then the CacheEntry table, so a restart doesn't send every lookup out again.
//
//   cached(key, ttlMs, fn)  -> fresh copy if one is younger than ttlMs, else fn() (shared by concurrent callers)
//   If fn() fails and an older copy exists (up to `staleMs`), the old copy is returned: a rate-limited or offline
//   service then shows slightly old data instead of an error.
import { db } from "./db";

interface Hit { at: number; v: unknown }
const MEM_MAX = 1500;
const PURGE_AFTER = 30 * 86400_000;
const g = globalThis as unknown as { __riftCache?: { mem: Map<string, Hit>; inflight: Map<string, Promise<unknown>>; purgedAt: number } };
const st = (g.__riftCache ??= { mem: new Map(), inflight: new Map(), purgedAt: 0 });

// Unit tests run without a database (and must not see each other's rows).
const dbOn = () => !process.env.VITEST || process.env.RIFT_CACHE_DB === "1";

function remember(key: string, h: Hit) {
  st.mem.delete(key);
  st.mem.set(key, h);
  if (st.mem.size > MEM_MAX) st.mem.delete(st.mem.keys().next().value!);
}

async function read(key: string): Promise<Hit | null> {
  const m = st.mem.get(key);
  if (m) return m;
  if (!dbOn()) return null;
  const row = await db.cacheEntry.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try {
    const h = { at: row.storedAt.getTime(), v: JSON.parse(row.value) };
    remember(key, h);
    return h;
  } catch { return null; }
}

async function write(key: string, v: unknown) {
  const h = { at: Date.now(), v };
  remember(key, h);
  if (!dbOn()) return;
  const value = JSON.stringify(v);
  if (value === undefined || value.length > 2_000_000) return;
  await db.cacheEntry.upsert({ where: { key }, create: { key, value, storedAt: new Date(h.at) }, update: { value, storedAt: new Date(h.at) } }).catch(() => {});
  if (Date.now() - st.purgedAt > 6 * 3600_000) {
    st.purgedAt = Date.now();
    void db.cacheEntry.deleteMany({ where: { storedAt: { lt: new Date(Date.now() - PURGE_AFTER) } } }).catch(() => {});
  }
}

export interface CacheOpts<T> {
  /** Return false for answers that must not be kept (e.g. "no result" from a source that was just down). */
  keep?: (v: T) => boolean;
  /** How old a copy may be when the live call fails (default 7 days). 0 = never fall back. */
  staleMs?: number;
  /** A different, usually shorter, lifetime for some answers (e.g. misses). */
  ttlFor?: (v: T) => number;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, o: CacheOpts<T> = {}): Promise<T> {
  const hit = await read(key);
  const life = (h: Hit) => (o.ttlFor ? o.ttlFor(h.v as T) : ttlMs);
  if (hit && Date.now() - hit.at < life(hit)) return hit.v as T;
  let p = st.inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      try {
        const v = await fn();
        if (!o.keep || o.keep(v)) await write(key, v);
        return v;
      } catch (e) {
        if (hit && Date.now() - hit.at < (o.staleMs ?? 7 * 86400_000)) return hit.v as T;
        throw e;
      }
    })().finally(() => st.inflight.delete(key));
    st.inflight.set(key, p);
  }
  return p;
}

/** Drop entries (memory and database) whose key starts with `prefix` (all of them when empty). */
export async function forget(prefix = "") {
  for (const k of [...st.mem.keys()]) if (k.startsWith(prefix)) st.mem.delete(k);
  st.inflight.clear();
  if (dbOn()) await (prefix ? db.cacheEntry.deleteMany({ where: { key: { startsWith: prefix } } }) : db.cacheEntry.deleteMany()).catch(() => {});
}

/** Memory only, synchronous (tests). */
export function forgetMemory(prefix = "") {
  for (const k of [...st.mem.keys()]) if (k.startsWith(prefix)) st.mem.delete(k);
  for (const k of [...st.inflight.keys()]) if (k.startsWith(prefix)) st.inflight.delete(k);
}
