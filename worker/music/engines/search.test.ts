import { describe, expect, it } from "vitest";
import type { Candidate, MusicConfig } from "../../../shared/music-protocol";
import { searchAll } from "./search";
import type { Engine } from "./types";

const cfg = {} as MusicConfig;
const cand = (engine: Candidate["engine"], sourceId: string, title: string, artist = "Artist", durationSec = 200): Candidate => ({ engine, sourceId, title, artist, durationSec, url: "", score: 1 });
const engine = (id: Engine["id"], result: Candidate[] | Error): Engine => ({
  id,
  search: async () => { if (result instanceof Error) throw result; return result; },
  resolve: async () => [], open: async () => { throw new Error("n/a"); },
});

describe("searchAll", () => {
  it("looks in every engine, not only the first that answers, and interleaves them (chain order first)", async () => {
    const lava = engine("lavalink", [cand("lavalink", "l1", "A1"), cand("lavalink", "l2", "A2"), cand("lavalink", "l3", "A3")]);
    const yt = engine("ytdlp", [cand("ytdlp", "y1", "B1"), cand("ytdlp", "y2", "B2")]);
    const r = await searchAll([lava, yt], "q", cfg, 10);
    expect(r.candidates.map((c) => c.sourceId)).toEqual(["l1", "y1", "l2", "y2", "l3"]);
    expect(r.engines).toEqual([{ engine: "lavalink", ok: true, count: 3 }, { engine: "ytdlp", ok: true, count: 2 }]);
  });

  it("collapses the same recording found by both sources (keeps the first source's)", async () => {
    const lava = engine("lavalink", [cand("lavalink", "l1", "Song", "Artist", 200)]);
    const yt = engine("ytdlp", [cand("ytdlp", "y1", "song", "ARTIST", 201), cand("ytdlp", "y2", "Another", "Artist", 150)]);
    const r = await searchAll([lava, yt], "q", cfg, 10);
    expect(r.candidates.map((c) => c.sourceId)).toEqual(["l1", "y2"]);
  });

  it("does not merge different lengths of the same title (live vs studio)", async () => {
    const r = await searchAll([engine("lavalink", [cand("lavalink", "l1", "Song", "A", 200)]), engine("ytdlp", [cand("ytdlp", "y1", "Song", "A", 330)])], "q", cfg, 10);
    expect(r.candidates).toHaveLength(2);
  });

  it("respects the limit, giving each source a share", async () => {
    const many = (e: Candidate["engine"], p: string) => Array.from({ length: 10 }, (_, i) => cand(e, `${p}${i}`, `${p} title ${i}`));
    const r = await searchAll([engine("lavalink", many("lavalink", "l")), engine("ytdlp", many("ytdlp", "y"))], "q", cfg, 6);
    expect(r.candidates.map((c) => c.sourceId)).toEqual(["l0", "y0", "l1", "y1", "l2", "y2"]);
  });

  it("one source failing still returns the other's results and reports the failure", async () => {
    const r = await searchAll([engine("lavalink", new Error("node offline")), engine("ytdlp", [cand("ytdlp", "y1", "B1")])], "q", cfg, 10);
    expect(r.candidates.map((c) => c.sourceId)).toEqual(["y1"]);
    expect(r.engines[0]).toEqual({ engine: "lavalink", ok: false, count: 0, error: "node offline" });
  });

  it("one source finding nothing is not an error", async () => {
    const r = await searchAll([engine("lavalink", []), engine("ytdlp", [cand("ytdlp", "y1", "B1")])], "q", cfg, 10);
    expect(r.candidates).toHaveLength(1);
    expect(r.engines[0].ok).toBe(true);
  });

  it("throws only when every source fails", async () => {
    await expect(searchAll([engine("lavalink", new Error("lava down")), engine("ytdlp", new Error("yt down"))], "q", cfg, 10)).rejects.toThrow("lava down");
  });

  it("a single engine behaves like before", async () => {
    const r = await searchAll([engine("ytdlp", [cand("ytdlp", "y1", "B1")])], "q", cfg, 10);
    expect(r.candidates).toHaveLength(1);
  });
});
