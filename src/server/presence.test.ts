import { describe, expect, it } from "vitest";
import { activityFor, publicImage, type NowPlaying } from "./presence";

const np = (o: Partial<NowPlaying> = {}): NowPlaying => ({ kind: "music", title: "Tone One", subtitle: "by Test Artist", album: "Test Album", image: "https://cdn-images.dzcdn.net/a.jpg", position: 30, duration: 200, playing: true, at: 1_000_000, ...o });
const on = { music: true, stream: true };

describe("activityFor", () => {
  it("shows a playing song as 'Listening' with a progress timeline", () => {
    const a = activityFor(np(), on, 1_005_000)!;
    expect(a).toMatchObject({ type: 2, details: "Tone One", state: "by Test Artist", assets: { large_image: "https://cdn-images.dzcdn.net/a.jpg", large_text: "Test Album" } });
    expect(a.timestamps).toEqual({ start: 1_000_000 - 30_000, end: 1_000_000 - 30_000 + 200_000 });
  });
  it("a paused song drops the timeline and says so", () => {
    const a = activityFor(np({ playing: false }), on, 1_060_000)!;
    expect(a.state).toBe("by Test Artist (paused)");
    expect(a.timestamps).toBeUndefined();
  });
  it("goes away when the player stopped reporting (closed tab) but a paused song stays for a while", () => {
    expect(activityFor(np(), on, 1_000_000 + 91_000)).toBeNull();
    expect(activityFor(np({ playing: false }), on, 1_000_000 + 5 * 60_000)).not.toBeNull();
    expect(activityFor(np({ playing: false }), on, 1_000_000 + 11 * 60_000)).toBeNull();
  });
  it("respects the per-kind switches (stream is off by default)", () => {
    expect(activityFor(np(), { music: false, stream: true })).toBeNull();
    expect(activityFor(np({ kind: "video" }), { music: true, stream: false }, 1_001_000)).toBeNull();
    expect(activityFor(np({ kind: "video", subtitle: "S1:E3 · Pilot" }), on, 1_001_000)).toMatchObject({ type: 3, state: "S1:E3 · Pilot" });
  });
  it("pads one-character titles (Discord needs 2+) and trims long ones to 128", () => {
    expect(activityFor(np({ title: "Ö" }), on, 1_001_000)!.details.length).toBeGreaterThanOrEqual(2);
    expect(activityFor(np({ title: "x".repeat(400) }), on, 1_001_000)!.details.length).toBe(128);
  });
  it("omits images when there is none", () => {
    expect(activityFor(np({ image: null, album: null }), on, 1_001_000)!.assets).toBeUndefined();
  });
});

describe("publicImage", () => {
  it("only passes pictures Discord can fetch", () => {
    expect(publicImage("https://cdn-images.dzcdn.net/a.jpg")).not.toBeNull();
    expect(publicImage("https://image.tmdb.org/t/p/w342/x.jpg")).not.toBeNull();
    expect(publicImage("/api/music/cover/abc")).toBeNull();
    expect(publicImage("http://192.168.1.5/x.jpg")).toBeNull();
    expect(publicImage(null)).toBeNull();
  });
});
