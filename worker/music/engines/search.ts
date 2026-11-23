import type { Candidate, MusicConfig } from "../../../shared/music-protocol";
import { normalize } from "../../../shared/music-match";
import type { Engine } from "./types";

export interface EngineReport { engine: Engine["id"]; ok: boolean; count: number; error?: string }

/** Two results are "the same recording" when title + artist match and the lengths are within a couple of seconds. */
const sameRecording = (a: Candidate, b: Candidate) =>
  normalize(a.title) === normalize(b.title) && normalize(a.artist) === normalize(b.artist) && Math.abs(a.durationSec - b.durationSec) <= 2;

/** Round-robin over several result lists (first list wins ties), dropping repeats and the same recording found twice. */
export function interleave(lists: Candidate[][], limit: number): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const c = l[i];
      if (c && out.length < limit && !out.some((o) => o.sourceId === c.sourceId || sameRecording(o, c))) out.push(c);
    }
  }
  return out;
}

/**
 * Search every engine in the chain at the same time (so "auto" with Lavalink configured looks in Lavalink AND yt-dlp, not
 * only the first one that answers), then interleave the answers (best of each source first, chain order breaks ties) and
 * drop near-identical duplicates. An engine that fails or finds nothing doesn't hide the others; only when every engine
 * fails is the error thrown.
 */
export async function searchAll(chain: Engine[], text: string, cfg: MusicConfig, limit: number): Promise<{ candidates: Candidate[]; engines: EngineReport[] }> {
  const settled = await Promise.allSettled(chain.map((e) => e.search(text, cfg, limit)));
  const engines: EngineReport[] = settled.map((r, i) => r.status === "fulfilled"
    ? { engine: chain[i].id, ok: true, count: r.value.length }
    : { engine: chain[i].id, ok: false, count: 0, error: (r.reason as Error)?.message ?? String(r.reason) });
  if (settled.length && settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;

  const out = interleave(settled.map((r) => (r.status === "fulfilled" ? r.value : [])), limit);
  return { candidates: out, engines };
}
