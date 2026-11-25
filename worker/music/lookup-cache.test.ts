import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LookupCache } from "./lookup-cache";

describe("LookupCache", () => {
  it("serves repeats from memory, shares concurrent calls, never stores errors", async () => {
    const c = new LookupCache();
    let n = 0;
    const fn = async () => ++n;
    expect(await Promise.all([c.wrap("k", 1000, fn), c.wrap("k", 1000, fn)])).toEqual([1, 1]);
    expect(await c.wrap("k", 1000, fn)).toBe(1);
    await expect(c.wrap("e", 1000, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(c.peek("e")).toBeUndefined();
  });

  it("falls back to an expired copy when the live call fails (rate limit), unless staleMs is 0", async () => {
    const c = new LookupCache();
    await c.wrap("k", 1000, async () => "old");
    const fail = async (): Promise<string> => { throw new Error("429"); };
    expect(await c.wrap("k", 0, fail)).toBe("old");
    await expect(c.wrap("k", 0, fail, { staleMs: 0 })).rejects.toThrow("429");
  });

  it("uses ttlFor (short life for misses) and keep", async () => {
    const c = new LookupCache();
    let n = 0;
    const miss = async () => { n++; return [] as number[]; };
    await c.wrap("m", 60_000, miss, { ttlFor: (v) => (v.length ? 60_000 : 0) });
    await c.wrap("m", 60_000, miss, { ttlFor: (v) => (v.length ? 60_000 : 0) });
    expect(n).toBe(2);
    await c.wrap("x", 60_000, async () => "no", { keep: () => false });
    expect(c.peek("x")).toBeUndefined();
  });

  it("persists to a file and loads it back; keeps at most `max` entries", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rift-lookups-")), "l.json");
    const a = new LookupCache(3);
    a.attach(file);
    for (const k of ["a", "b", "c", "d"]) await a.wrap(k, 1000, async () => k.toUpperCase());
    a.flush();
    const b = new LookupCache();
    b.attach(file);
    expect(b.size).toBe(3);
    expect(b.peek("a")).toBeUndefined();
    expect(b.peek<string>("d")?.v).toBe("D");
  });
});
