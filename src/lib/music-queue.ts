// Pure queue logic (no I/O): play order, shuffle, repeat, next/previous and which items to preload.
export type RepeatMode = "off" | "all" | "one";
export interface QItem { id: string; position: number }
export interface QState { currentItemId: string | null; shuffle: boolean; repeat: RepeatMode; shuffleOrder: string[] | null }

/** Fisher-Yates over `ids` with `current` pinned first. `rng` is injectable for tests. */
export function makeShuffleOrder(ids: string[], currentId: string | null, rng: () => number = Math.random): string[] {
  const rest = ids.filter((i) => i !== currentId);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return currentId && ids.includes(currentId) ? [currentId, ...rest] : rest;
}

/** Item ids in the order they will play. With shuffle on this is the stored shuffle order, kept consistent with the queue. */
export function playOrder(items: QItem[], st: Pick<QState, "shuffle" | "shuffleOrder">): string[] {
  const byPos = [...items].sort((a, b) => a.position - b.position).map((i) => i.id);
  if (!st.shuffle || !st.shuffleOrder) return byPos;
  const exists = new Set(byPos);
  const kept = st.shuffleOrder.filter((id) => exists.has(id));
  const known = new Set(kept);
  return [...kept, ...byPos.filter((id) => !known.has(id))]; // items added after shuffling go to the end
}

/** What plays after `current`: null at the end of the queue (repeat off), wrapping with repeat "all". */
export function nextId(items: QItem[], st: QState, opts: { auto?: boolean } = {}): string | null {
  const order = playOrder(items, st);
  if (!order.length) return null;
  const cur = st.currentItemId ? order.indexOf(st.currentItemId) : -1;
  if (opts.auto && st.repeat === "one" && cur >= 0) return order[cur]; // natural end of a track repeats it
  if (cur < 0) return order[0];
  if (cur + 1 < order.length) return order[cur + 1];
  return st.repeat === "all" ? order[0] : null;
}

export function prevId(items: QItem[], st: QState): string | null {
  const order = playOrder(items, st);
  if (!order.length) return null;
  const cur = st.currentItemId ? order.indexOf(st.currentItemId) : -1;
  if (cur > 0) return order[cur - 1];
  return st.repeat === "all" ? order[order.length - 1] : order[0];
}

/** Up to `n` distinct upcoming items after the current one (for preloading). Empty while repeating a single track. */
export function upcoming(items: QItem[], st: QState, n: number): string[] {
  if (n <= 0 || st.repeat === "one") return [];
  const order = playOrder(items, st);
  const cur = st.currentItemId ? order.indexOf(st.currentItemId) : -1;
  const out: string[] = [];
  for (let k = 1; k < order.length && out.length < n; k++) {
    const idx = cur + k;
    if (idx < order.length) out.push(order[idx]);
    else if (st.repeat === "all") { const w = idx % order.length; if (w !== cur) out.push(order[w]); }
  }
  return [...new Set(out)];
}

/** Position values after moving `id` to `toIndex` (0-based) in the position-ordered list. */
export function moveItem(ids: string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const out = ids.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, id);
  return out;
}
