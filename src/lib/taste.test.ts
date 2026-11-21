import { describe, expect, it } from "vitest";
import { FRESH_YEARS, cutoffYear, isRecent, sinceParam, PICK_COUNT, parseFavoriteGenres, scoreTaste, tasteKeyOfId, TASTE_GENRES } from "./taste";

const SCIFI = 878, COMEDY = 35, HORROR = 27, TV_SCIFI = 10765;
const w = (genres: number[], over: Partial<{ fraction: number; completed: boolean; ageDays: number }> = {}) => ({ genres, fraction: 1, completed: true, ageDays: 1, ...over });

describe("taste", () => {
  it("maps movie and tv genre ids onto the same taste, and every id belongs to one taste only", () => {
    expect(tasteKeyOfId(SCIFI)).toBe("scifi");
    expect(tasteKeyOfId(TV_SCIFI)).toBe("scifi");
    const all = TASTE_GENRES.flatMap((g) => g.ids);
    expect(new Set(all).size).toBe(all.length);
  });
  it("parses stored picks defensively", () => {
    expect(parseFavoriteGenres('["scifi","comedy","nope","scifi","drama","horror"]')).toEqual(["scifi", "comedy", "drama"].slice(0, PICK_COUNT));
    expect(parseFavoriteGenres("garbage")).toEqual([]);
    expect(parseFavoriteGenres(null)).toEqual([]);
  });
  it("uses the picks as a prior when there is no history", () => {
    const s = scoreTaste({ picks: ["comedy", "horror", "drama"], watched: [], saved: [] });
    expect(s.map((x) => x.key)).toEqual(["comedy", "horror", "drama"]); // pick order breaks ties
  });
  it("lets real history overtake the onboarding picks", () => {
    const watched = Array.from({ length: 6 }, () => w([SCIFI]));
    const s = scoreTaste({ picks: ["comedy"], watched, saved: [] });
    expect(s[0].key).toBe("scifi");
  });
  it("weights completed above barely-started and ignores accidental starts", () => {
    const s = scoreTaste({ picks: [], watched: [w([HORROR], { completed: false, fraction: 0.05 }), w([COMEDY], { completed: false, fraction: 0.5 })], saved: [] });
    expect(s.map((x) => x.key)).toEqual(["comedy"]);
  });
  it("fades old viewing and counts My List", () => {
    const s = scoreTaste({ picks: [], watched: [w([HORROR], { ageDays: 720 })], saved: [{ genres: [COMEDY], ageDays: 1 }] });
    expect(s[0].key).toBe("comedy");
  });
  it("splits a multi-genre title's weight instead of double counting", () => {
    const [a] = scoreTaste({ picks: [], watched: [w([SCIFI, COMEDY])], saved: [] });
    const [b] = scoreTaste({ picks: [], watched: [w([SCIFI])], saved: [] });
    expect(a.score).toBeLessThan(b.score);
  });

  it("windows recommendations to recent years", () => {
    const now = new Date("2026-11-21");
    expect(cutoffYear(FRESH_YEARS, now)).toBe(2016);
    expect(sinceParam("movie", 10, now)).toEqual({ "primary_release_date.gte": "2016-01-01" });
    expect(sinceParam("tv", 20, now)).toEqual({ "first_air_date.gte": "2006-01-01" });
    expect(isRecent(1994, 10, now)).toBe(false);
    expect(isRecent(2016, 10, now)).toBe(true);
    expect(isRecent(null, 10, now)).toBe(true);
  });
});
