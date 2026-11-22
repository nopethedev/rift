import { describe, expect, it } from "vitest";
import { makeShuffleOrder, moveItem, nextId, playOrder, prevId, upcoming, type QItem, type QState } from "./music-queue";

const items = (...ids: string[]): QItem[] => ids.map((id, i) => ({ id, position: i }));
const st = (over: Partial<QState> = {}): QState => ({ currentItemId: "b", shuffle: false, repeat: "off", shuffleOrder: null, ...over });
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

describe("queue order", () => {
  it("plays in position order", () => {
    expect(playOrder(items("a", "b", "c").reverse(), st())).toEqual(["a", "b", "c"]);
  });
  it("shuffle keeps the current track first and is a permutation", () => {
    const o = makeShuffleOrder(["a", "b", "c", "d", "e"], "c", seeded());
    expect(o[0]).toBe("c");
    expect([...o].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("shuffled order survives removals and appends new items at the end", () => {
    const s = st({ shuffle: true, shuffleOrder: ["c", "a", "d", "b"] });
    expect(playOrder(items("a", "b", "c", "e"), s)).toEqual(["c", "a", "b", "e"]);
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
  it("follows the shuffle order", () => {
    const s = st({ shuffle: true, shuffleOrder: ["b", "d", "a", "c"], currentItemId: "b" });
    expect(nextId(items("a", "b", "c", "d"), s)).toBe("d");
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
