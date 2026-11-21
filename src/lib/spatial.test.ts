import { describe, expect, it } from "vitest";
import { type Box, pickNext } from "./spatial";

const box = (x: number, y: number, w = 100, h = 150): Box => ({ left: x, top: y, right: x + w, bottom: y + h });

describe("pickNext", () => {
  // two rows of three cards
  const grid = [0, 1, 2].flatMap((c) => [box(c * 110, 0), box(c * 110, 200)]); // [r0c0, r1c0, r0c1, r1c1, r0c2, r1c2]
  it("moves along a row", () => {
    expect(pickNext(grid[0], grid, "right")).toBe(2);
    expect(pickNext(grid[2], grid, "left")).toBe(0);
  });
  it("moves between rows keeping the column", () => {
    expect(pickNext(grid[2], grid, "down")).toBe(3);
    expect(pickNext(grid[5], grid, "up")).toBe(4);
  });
  it("returns -1 at the edges", () => {
    expect(pickNext(grid[0], grid, "left")).toBe(-1);
    expect(pickNext(grid[0], grid, "up")).toBe(-1);
    expect(pickNext(grid[5], grid, "right")).toBe(-1);
  });
  it("prefers the aligned row over a nearer card in another row", () => {
    const from = box(0, 0);
    const sameRowFar = box(400, 0);
    const otherRowNear = box(120, 170);
    expect(pickNext(from, [otherRowNear, sameRowFar], "right")).toBe(1);
  });
  it("goes to the horizontally closest item of the next row (offset carousels)", () => {
    const from = box(300, 0);
    const below = [box(0, 200), box(110, 200), box(220, 200), box(330, 200)];
    expect(pickNext(from, below, "down")).toBe(3);
  });
});
