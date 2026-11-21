import { describe, expect, it } from "vitest";
import { hashSecret, verifySecret, newToken, sha256 } from "./security";
import { rateLimit, resetRateLimit } from "./ratelimit";

describe("security", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashSecret("correct horse");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifySecret("correct horse", h)).toBe(true);
    expect(await verifySecret("wrong", h)).toBe(false);
    expect(await verifySecret("x", "garbage")).toBe(false);
  });
  it("uses unique salts", async () => {
    expect(await hashSecret("a")).not.toBe(await hashSecret("a"));
  });
  it("generates unique tokens", () => {
    expect(newToken()).not.toBe(newToken());
    expect(sha256("a")).toHaveLength(64);
  });
});

describe("rateLimit", () => {
  it("blocks after max hits and resets", () => {
    const k = "test:" + Math.random();
    expect(rateLimit(k, 3, 60_000)).toBe(0);
    expect(rateLimit(k, 3, 60_000)).toBe(0);
    expect(rateLimit(k, 3, 60_000)).toBe(0);
    expect(rateLimit(k, 3, 60_000)).toBeGreaterThan(0);
    resetRateLimit(k);
    expect(rateLimit(k, 3, 60_000)).toBe(0);
  });
});
