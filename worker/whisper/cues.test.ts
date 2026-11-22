import { describe, expect, it } from "vitest";
import { cleanCues, toVtt, vttTime, windowEnergy, wordsToCues, wrapLines, type Word } from "./cues";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const speak = (s: string, t0 = 0, per = 0.4): Word[] => s.split(" ").map((x, i) => w(" " + x, t0 + i * per, t0 + i * per + per * 0.9));

describe("wordsToCues", () => {
  it("splits on pauses and keeps ordering", () => {
    const cues = wordsToCues([...speak("hello there", 0), ...speak("how are you", 5)]);
    expect(cues.map((c) => c.text)).toEqual(["hello there", "how are you"]);
    expect(cues[0].start).toBe(0);
    expect(cues[1].start).toBeGreaterThanOrEqual(5);
  });
  it("never exceeds two lines of 42 characters or 7 seconds", () => {
    const long = speak("this is a very long sentence that keeps going and going without any punctuation at all so it has to be cut somewhere sensible", 0, 0.35);
    const cues = wordsToCues(long);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) {
      expect(c.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(Math.max(...c.text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(42);
      expect(c.end - c.start).toBeLessThanOrEqual(8);
    }
  });
  it("breaks after a finished sentence once the cue is long enough", () => {
    const cues = wordsToCues([...speak("We went to the market yesterday morning.", 0, 0.3), ...speak("It was crowded.", 2.9, 0.3)]);
    expect(cues).toHaveLength(2);
    expect(cues[0].text.replace("\n", " ")).toBe("We went to the market yesterday morning.");
  });
  it("cues never overlap and have a minimum duration", () => {
    const cues = wordsToCues([w(" Hi.", 1, 1.1), w(" Yes.", 1.5, 1.6), ...speak("and more words here", 6)]);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    expect(cues[0].end - cues[0].start).toBeGreaterThanOrEqual(0.5);
  });
  it("ignores empty / invalid words and handles unsorted input", () => {
    const cues = wordsToCues([w(" b", 1, 1.3), w("  ", 0, 1), w(" a", 0.5, 0.9), w(" x", NaN, 2)]);
    expect(cues.map((c) => c.text)).toEqual(["a b"]);
  });
  it("attaches punctuation without a leading space", () => {
    expect(wordsToCues([w(" Well", 0, 0.3), w(" ,", 0.3, 0.4), w(" yes", 0.4, 0.7), w(" !", 0.7, 0.8)])[0].text).toBe("Well, yes!");
  });
});

describe("long cues", () => {
  it("cut at a natural break (comma / pause) rather than at the limit", () => {
    const words = [...speak("And so my fellow Americans ask not what your country can do for you,", 0, 0.45), ...speak("ask what you can do for your country.", 7.4, 0.45)];
    const cues = wordsToCues(words);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues[0].text.replace(/\n/g, " ").endsWith("for you,")).toBe(true);
    expect(cues[1].text.replace(/\n/g, " ").startsWith("ask what")).toBe(true);
  });
  it("keeps line breaks through cleaning", () => {
    const cues = cleanCues(wordsToCues(speak("this is a fairly long line of speech that needs two lines to be shown", 0, 0.3)));
    expect(cues.some((c) => c.text.includes("\n"))).toBe(true);
  });
});

describe("wrapLines", () => {
  it("balances two lines and leaves short text alone", () => {
    expect(wrapLines("short", 42, 2)).toBe("short");
    const t = wrapLines("The quick brown fox jumps over the lazy dog and runs away", 42, 2).split("\n");
    expect(t).toHaveLength(2);
    expect(Math.abs(t[0].length - t[1].length)).toBeLessThan(15);
  });
});

describe("cleanCues", () => {
  const c = (text: string, start = 0, end = 2) => ({ start, end, text });
  it("drops credits/watermark hallucinations", () => {
    expect(cleanCues([c("Subtitles by the Amara.org community"), c("Thanks for watching!"), c("real line")]).map((x) => x.text)).toEqual(["real line"]);
  });
  it("drops weak filler only over quiet audio", () => {
    const loud = cleanCues([c("Thank you.")], { rms: () => 0.2 });
    const quiet = cleanCues([c("Thank you.")], { rms: () => 0.001 });
    expect(loud).toHaveLength(1);
    expect(quiet).toHaveLength(0);
  });
  it("drops text over silence but keeps sound-effect markers", () => {
    expect(cleanCues([c("some words")], { rms: () => 0.0005 })).toHaveLength(0);
    expect(cleanCues([c("[Music]")], { rms: () => 0.0005 })).toHaveLength(1);
  });
  it("collapses repetition loops and merges immediate repeats", () => {
    const loop = Array.from({ length: 8 }, (_, i) => c("I don't know.", i * 3, i * 3 + 2));
    expect(cleanCues(loop).length).toBeLessThanOrEqual(3);
    const merged = cleanCues([c("Hello", 0, 1), c("hello", 1.2, 2)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].end).toBe(2);
  });
});

describe("WebVTT output", () => {
  it("formats times and escapes cue text", () => {
    expect(vttTime(3723.456)).toBe("01:02:03.456");
    expect(vttTime(-1)).toBe("00:00:00.000");
    const v = toVtt([{ start: 1, end: 2.5, text: "a <b> & c --> d" }]);
    expect(v.startsWith("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n")).toBe(true);
    expect(v).toContain("a &lt;b&gt; &amp; c --&gt; d");
    expect(v.endsWith("\n\n")).toBe(true);
  });
});

describe("windowEnergy", () => {
  it("averages bins in a time range", () => {
    const bins = new Float32Array([0, 0, 1, 1, 0]); // 0.5 s per bin
    expect(windowEnergy(bins, 0.5, 1, 2)).toBeCloseTo(1);
    expect(windowEnergy(bins, 0.5, 0, 2.5)).toBeCloseTo(0.4);
    expect(windowEnergy(bins, 0.5, 10, 11)).toBeUndefined();
    expect(windowEnergy(new Float32Array([-1, 0.2, -1]), 0.5, 0, 1.5)).toBeCloseTo(0.2); // unmeasured bins are ignored
    expect(windowEnergy(new Float32Array([-1, -1]), 0.5, 0, 1)).toBeUndefined();
  });
});
