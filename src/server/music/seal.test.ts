import { describe, expect, it } from "vitest";
import { seal, unseal } from "./seal";
import type { Candidate } from "@shared/music-protocol";

const c: Candidate = { engine: "ytdlp", sourceId: "youtube:abc", title: "T", artist: "A", durationSec: 100, url: "https://example.com/watch?v=abc", score: 0.9 };

describe("candidate sealing", () => {
  it("accepts what the server issued", () => expect(unseal(seal(c))?.sourceId).toBe("youtube:abc"));
  it("survives a JSON round trip (client / database)", () => expect(unseal(JSON.parse(JSON.stringify(seal(c))))).not.toBeNull());
  it("ignores non-security fields like score and title", () => expect(unseal({ ...seal(c), score: 0.1, title: "other" })).not.toBeNull());
  it("rejects a tampered URL, source id, engine or Lavalink blob", () => {
    const s = seal(c);
    expect(unseal({ ...s, url: "http://169.254.169.254/latest/meta-data" })).toBeNull();
    expect(unseal({ ...s, sourceId: "youtube:zzz" })).toBeNull();
    expect(unseal({ ...s, engine: "lavalink" })).toBeNull();
    expect(unseal({ ...s, encoded: "QAAA" })).toBeNull();
  });
  it("rejects unsigned or malformed input", () => {
    expect(unseal(c)).toBeNull();
    expect(unseal({ ...c, sig: "x" })).toBeNull();
    expect(unseal(null)).toBeNull();
    expect(unseal("string")).toBeNull();
    expect(unseal({ ...seal(c), sig: 5 })).toBeNull();
  });
});
