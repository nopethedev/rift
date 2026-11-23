import { describe, expect, it } from "vitest";
import { makeShuffleOrder, moveItem, nextId, playOrder, prevId, restoreOrder, upcoming, type QItem, type QState } from "./music-queue";

const items = (...ids: string[]): QItem[] => ids.map((id, i) => ({ id, position: i }));
const st = (over: Partial<QState> = {}): QState => ({ currentItemId: "b", repeat: "off", ...over });
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

describe("queue order", () => {
  it("plays in position order", () => {
    expect(playOrder(items("a", "b", "c").reverse())).toEqual(["a", "b", "c"]);
  });
  it("shuffle keeps the current track first and is a permutation", () => {
    const o = makeShuffleOrder(["a", "b", "c", "d", "e"], "c", seeded());
    expect(o[0]).toBe("c");
    expect([...o].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("shuffle gives the same result for the same random numbers and never loses items", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `i${i}`);
    expect(makeShuffleOrder(ids, "i7", seeded(3))).toEqual(makeShuffleOrder(ids, "i7", seeded(3)));
    expect(makeShuffleOrder(ids, "i7", seeded(3))).not.toEqual(ids);
    expect(makeShuffleOrder(ids, null).sort()).toEqual([...ids].sort());
  });
});

describe("restoreOrder (shuffle off)", () => {
  it("brings back the original order", () => {
    const orig = ["a", "b", "c", "d", "e"];
    const shuffled = makeShuffleOrder(orig, "c", seeded(5));
    expect(restoreOrder(orig, shuffled)).toEqual(orig);
  });
  it("drops removed items and keeps items added while shuffled behind the song they followed", () => {
    // original a b c d; shuffled: c, x(new), a, d, y(new), b with "b" removed afterwards
    expect(restoreOrder(["a", "b", "c", "d"], ["c", "x", "a", "d", "y"])).toEqual(["a", "c", "x", "d", "y"]);
  });
  it("puts new items that lead the queue at the front and copes with an empty snapshot", () => {
    expect(restoreOrder(["a", "b"], ["n", "b", "a"])).toEqual(["n", "a", "b"]);
    expect(restoreOrder([], ["q", "r"])).toEqual(["q", "r"]);
  });
});

describe("next / previous", () => {
  it("advances and stops at the end with repeat off", () => {
    expect(nextId(items("a", "b", "c"), st())).toBe("c");
    expect(nextId(items("a", "b", "c"), st({ currentItemId: "c" }))).toBeNull();
  });
  it("wraps with repeat all", () => {
    expect(nextId(items("a", "b", "c"), st({ currentItemId: "c", repeat: "all" }))).toBe("a");
    expect(prevId(items("a", "b", "c"), st({ currentItemId: "a", repeat: "all" }))).toBe("c");
  });
  it("repeat one replays on natural end but a manual skip still moves on", () => {
    const s = st({ repeat: "one" });
    expect(nextId(items("a", "b", "c"), s, { auto: true })).toBe("b");
    expect(nextId(items("a", "b", "c"), s)).toBe("c");
  });
  it("starts at the first item when nothing is current", () => {
    expect(nextId(items("a", "b"), st({ currentItemId: null }))).toBe("a");
    expect(nextId([], st())).toBeNull();
  });
  it("previous clamps at the start when not repeating", () => {
    expect(prevId(items("a", "b"), st({ currentItemId: "a" }))).toBe("a");
    expect(prevId(items("a", "b"), st({ currentItemId: "b" }))).toBe("a");
  });
});

describe("upcoming (preload set)", () => {
  it("returns the next n items", () => {
    expect(upcoming(items("a", "b", "c", "d", "e"), st(), 2)).toEqual(["c", "d"]);
    expect(upcoming(items("a", "b", "c"), st(), 5)).toEqual(["c"]);
  });
  it("wraps for repeat all without including the current track twice", () => {
    expect(upcoming(items("a", "b", "c"), st({ currentItemId: "c", repeat: "all" }), 3)).toEqual(["a", "b"]);
  });
  it("is empty for repeat one and n=0", () => {
    expect(upcoming(items("a", "b", "c"), st({ repeat: "one" }), 2)).toEqual([]);
    expect(upcoming(items("a", "b", "c"), st(), 0)).toEqual([]);
  });
});

describe("moveItem", () => {
  it("reorders", () => {
    expect(moveItem(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c", "d"], "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(["a"], "zzz", 0)).toEqual(["a"]);
  });
});

import { songKey } from "./music-types";
describe("songKey", () => {
  it("is case, accent and punctuation insensitive and matches artist|title", () => {
    expect(songKey("Beyoncé", "Halo!")).toBe(songKey("BEYONCE", "halo"));
    expect(songKey("Simon & Garfunkel", "The Boxer")).toBe("simon and garfunkel|the boxer");
  });
});
