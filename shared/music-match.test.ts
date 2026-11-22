import { describe, expect, it } from "vitest";
import { MATCH_THRESHOLD, isOpenLicense, scoreCandidate, variantFlags } from "./music-match";

const q = { title: "Blinding Lights", artist: "The Weeknd", durationSec: 200 };

describe("scoreCandidate", () => {
  it("accepts the studio recording", () => {
    const r = scoreCandidate(q, { title: "The Weeknd - Blinding Lights (Official Audio)", artist: "TheWeekndVEVO", durationSec: 202 });
    expect(r.score).toBeGreaterThan(MATCH_THRESHOLD);
  });
  it("prefers a Topic channel upload", () => {
    const a = scoreCandidate(q, { title: "Blinding Lights", artist: "The Weeknd - Topic", durationSec: 200 });
    const b = scoreCandidate(q, { title: "Blinding Lights", artist: "RandomUser", durationSec: 200 });
    expect(a.score).toBeGreaterThan(b.score);
  });
  it.each(["Blinding Lights (Remix)", "Blinding Lights - Live at Wembley", "Blinding Lights cover by Sam", "Blinding Lights Karaoke Version", "Blinding Lights (Sped Up)", "Blinding Lights 8D Audio"])(
    "rejects %s", (title) => {
      expect(scoreCandidate(q, { title: `The Weeknd - ${title}`, artist: "x", durationSec: 200 }).score).toBeLessThan(MATCH_THRESHOLD);
    });
  it("accepts variants when asked for", () => {
    const live = { title: "Blinding Lights (Live)", artist: "The Weeknd", durationSec: 200 };
    expect(scoreCandidate({ ...q, allowVariants: true }, live).score).toBeGreaterThan(MATCH_THRESHOLD);
    expect(scoreCandidate({ ...q, title: "Blinding Lights (Live)" }, live).score).toBeGreaterThan(MATCH_THRESHOLD);
  });
  it("rejects wrong duration and live streams", () => {
    expect(scoreCandidate(q, { title: "The Weeknd - Blinding Lights", artist: "x", durationSec: 600 }).score).toBeLessThan(MATCH_THRESHOLD);
    expect(scoreCandidate(q, { title: "Blinding Lights", artist: "The Weeknd", durationSec: 0, isLive: true }).score).toBe(0);
  });
  it("rejects a different song by the same artist", () => {
    expect(scoreCandidate(q, { title: "The Weeknd - Starboy", artist: "The Weeknd", durationSec: 230 }).score).toBeLessThan(MATCH_THRESHOLD);
  });
  it("ignores feat. credits and accents", () => {
    const r = scoreCandidate({ title: "Déjà vu (feat. Someone)", artist: "Beyoncé", durationSec: 240 }, { title: "Beyonce - Deja vu", artist: "Beyoncé", durationSec: 240 });
    expect(r.score).toBeGreaterThan(MATCH_THRESHOLD);
  });
});

describe("helpers", () => {
  it("detects variants", () => {
    expect([...variantFlags("Song (Live at Madison Square Garden)")]).toContain("live");
    expect(variantFlags("Plain Song").size).toBe(0);
  });
  it("recognises open licences only", () => {
    expect(isOpenLicense("Creative Commons Attribution license (reuse allowed)")).toBe(true);
    expect(isOpenLicense("cc-by-sa")).toBe(true);
    expect(isOpenLicense("public domain")).toBe(true);
    expect(isOpenLicense("all-rights-reserved")).toBe(false);
    expect(isOpenLicense("Standard YouTube License")).toBe(false);
    expect(isOpenLicense(undefined)).toBe(false);
  });
});
