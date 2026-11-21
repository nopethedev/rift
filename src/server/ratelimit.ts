import "server-only";

interface Bucket { hits: number[] }
const g = globalThis as unknown as { __riftRl?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__riftRl ??= new Map());
let lastSweep = Date.now();

/** Sliding-window limiter (in-memory, per process). Returns retry-after seconds when limited, otherwise 0. */
export function rateLimit(key: string, max: number, windowMs: number): number {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (!b.hits.length || now - b.hits[b.hits.length - 1] > 15 * 60_000) buckets.delete(k);
  }
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= max) {
    buckets.set(key, b);
    return Math.max(1, Math.ceil((windowMs - (now - b.hits[0])) / 1000));
  }
  b.hits.push(now);
  buckets.set(key, b);
  return 0;
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}
