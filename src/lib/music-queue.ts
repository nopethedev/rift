// Pure queue logic (no I/O): play order, shuffle, repeat, next/previous and which items to preload.
export type RepeatMode = "off" | "all" | "one";
export interface QItem { id: string; position: number }
export interface QState { currentItemId: string | null; repeat: RepeatMode }

/** Fisher-Yates over `ids` with `current` pinned first (what the queue becomes when shuffle is switched on). `rng` is injectable for tests. */
export function makeShuffleOrder(ids: string[], currentId: string | null, rng: () => number = Math.random): string[] {
  const rest = ids.filter((i) => i !== currentId);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return currentId && ids.includes(currentId) ? [currentId, ...rest] : rest;
}

/** Item ids in the order they play. The queue itself is the play order: shuffling physically reorders it (see `restoreOrder`). */
export function playOrder(items: QItem[]): string[] {
  return [...items].sort((a, b) => a.position - b.position).map((i) => i.id);
}

/**
 * Un-shuffle: the order the queue had before shuffling (`original`), minus removed items. Items that were added while
 * shuffled (not in `original`) stay right behind the item they currently follow, so nothing the user queued is lost or moved far.
 */
export function restoreOrder(original: string[], current: string[]): string[] {
  const now = new Set(current);
  const orig = original.filter((id) => now.has(id));
  const known = new Set(orig);
  if (!orig.length) return [...current];
  const after = new Map<string, string[]>(); // anchor id -> new items to put behind it
  const head: string[] = [];
  let anchor: string | null = null;
  for (const id of current) {
    if (known.has(id)) { anchor = id; continue; }
    if (anchor === null) head.push(id); else after.set(anchor, [...(after.get(anchor) ?? []), id]);
  }
  return [...head, ...orig.flatMap((id) => [id, ...(after.get(id) ?? [])])];
}

/** What plays after `current`: null at the end of the queue (repeat off), wrapping with repeat "all". */
export function nextId(items: QItem[], st: QState, opts: { auto?: boolean } = {}): string | null {
  const order = playOrder(items);
  if (!order.length) return null;
  const cur = st.currentItemId ? order.indexOf(st.currentItemId) : -1;
  if (opts.auto && st.repeat === "one" && cur >= 0) return order[cur]; // natural end of a track repeats it
  if (cur < 0) return order[0];
  if (cur + 1 < order.length) return order[cur + 1];
  return st.repeat === "all" ? order[0] : null;
}

export function prevId(items: QItem[], st: QState): string | null {
  const order = playOrder(items);
  if (!order.length) return null;
  const cur = st.currentItemId ? order.indexOf(st.currentItemId) : -1;
  if (cur > 0) return order[cur - 1];
  return st.repeat === "all" ? order[order.length - 1] : order[0];
}

/** Up to `n` distinct upcoming items after the current one (for preloading). Empty while repeating a single track. */
export function upcoming(items: QItem[], st: QState, n: number): string[] {
  if (n <= 0 || st.repeat === "one") return [];
  const order = playOrder(items);
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
