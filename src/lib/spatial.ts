// Pure geometry for D-pad / arrow-key navigation (no DOM access, unit tested).

export type Dir = "left" | "right" | "up" | "down";
export interface Box { left: number; top: number; right: number; bottom: number }

const gap = (a1: number, a2: number, b1: number, b2: number) => (b1 > a2 ? b1 - a2 : a1 > b2 ? a1 - b2 : 0); // distance between two intervals, 0 if they overlap

/**
 * Index of the best candidate in direction `dir` from `from`, or -1.
 * Candidates must lie in that direction; those sharing the cross-axis span (same row / column) win, then the closest one.
 */
export function pickNext(from: Box, candidates: Box[], dir: Dir): number {
  const horizontal = dir === "left" || dir === "right";
  const fcx = (from.left + from.right) / 2;
  const fcy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    const ccx = (c.left + c.right) / 2;
    const ccy = (c.top + c.bottom) / 2;
    // Direction test: centre must be past the origin's centre and the candidate must reach beyond the origin's edge.
    const ahead =
      dir === "right" ? ccx > fcx + 1 && c.right > from.right + 1
      : dir === "left" ? ccx < fcx - 1 && c.left < from.left - 1
      : dir === "down" ? ccy > fcy + 1 && c.bottom > from.bottom + 1
      : ccy < fcy - 1 && c.top < from.top - 1;
    if (!ahead) return;
    const primary = horizontal
      ? gap(from.left, from.right, c.left, c.right)
      : gap(from.top, from.bottom, c.top, c.bottom);
    const crossGap = horizontal
      ? gap(from.top, from.bottom, c.top, c.bottom)
      : gap(from.left, from.right, c.left, c.right);
    const crossCenter = horizontal ? Math.abs(ccy - fcy) : Math.abs(ccx - fcx);
    const along = horizontal ? Math.abs(ccx - fcx) : Math.abs(ccy - fcy);
    // Candidates in the same row/column (cross-axis overlap) always beat ones that are off to the side.
    const score = (crossGap > 0 ? 1e6 : 0) + primary + crossGap * 4 + crossCenter * 0.3 + along * 0.05;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
