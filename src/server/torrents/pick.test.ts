import { describe, expect, it } from "vitest";
import { hashOfResult, rankCandidates, scoreResult } from "./pick";
import type { TorrentSearchResult } from "./search";

let n = 0;
const t = (title: string, seeds = 50, sizeGB?: number, extra: Partial<TorrentSearchResult> = {}): TorrentSearchResult => ({
  id: String(++n), title, provider: "x", seeds, peers: 0, size: sizeGB ? `${sizeGB} GB` : "?", sizeBytes: sizeGB ? sizeGB * 1024 ** 3 : undefined, ...extra,
});
const movie = { title: "Neon Horizon", year: 2010, mediaType: "movie" as const };
const ep = { title: "Silent Orbit", mediaType: "tv" as const, season: 1, episode: 2 };

describe("source picking", () => {
  it("prefers a browser-friendly 1080p H.264 WEB-DL over a 4K HDR remux, CAMs and 10-bit", () => {
    const list = [
      t("Neon Horizon 2010 2160p UHD BluRay REMUX HDR10 HEVC TrueHD Atmos", 200, 60),
      t("Neon Horizon 2010 HDCAM x264", 500, 1.4),
      t("Neon Horizon 2010 1080p BluRay x265 10bit", 300, 2.5),
      t("Neon Horizon (2010) 1080p WEB-DL DDP5.1 H.264", 60, 4.2),
      t("Neon Horizon 2010 720p WEBRip x264 AAC", 20, 1.2),
    ];
    const r = rankCandidates(list, movie);
    expect(r[0].result.title).toContain("WEB-DL");
    expect(r.some((c) => c.result.title.includes("HDCAM"))).toBe(false);
    expect(r.findIndex((c) => c.result.title.includes("10bit"))).toBeGreaterThan(1);
  });
  it("rejects other titles, wrong years, episodes and dead torrents", () => {
    expect(scoreResult(t("Neon Horizon 2 2014 1080p WEB-DL x264"), movie)).toBeNull();
    expect(scoreResult(t("Neon Horizon 1994 1080p BluRay x264"), movie)).toBeNull();
    expect(scoreResult(t("Neon Horizon S01E01 1080p WEB-DL x264"), movie)).toBeNull();
    expect(scoreResult(t("Neon Horizon 2010 1080p WEB-DL x264", 0), movie)).toBeNull();
    expect(scoreResult(t("Neon Horizon 2010 1080p WEB-DL x264", 0, 4, { provider: "Internet Archive" }), movie)).not.toBeNull();
  });
  it("matches the exact episode, accepts a season pack, rejects other episodes and seasons", () => {
    expect(scoreResult(t("Silent Orbit S01E02 1080p WEB-DL x264"), ep)?.pack).toBe(false);
    expect(scoreResult(t("Silent Orbit S01E03 1080p WEB-DL x264"), ep)).toBeNull();
    expect(scoreResult(t("Silent Orbit S02E02 1080p WEB-DL x264"), ep)).toBeNull();
    expect(scoreResult(t("Silent Orbit S01E01-E03 1080p WEB-DL x264"), ep)).not.toBeNull();
    const pack = scoreResult(t("Silent Orbit S01 1080p WEB-DL x264", 80, 12), ep);
    expect(pack?.pack).toBe(true);
    const single = scoreResult(t("Silent Orbit S01E02 1080p WEB-DL x264", 80, 1.1), ep)!;
    expect(single.score).toBeGreaterThan(pack!.score);
  });
  it("skips excluded hashes (retry with the next source)", () => {
    const a = t("Neon Horizon 2010 1080p WEB-DL x264", 90, 3, { infoHash: "A".repeat(40) });
    const b = t("Neon Horizon 2010 720p WEB-DL x264", 40, 1.5, { magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}` });
    expect(rankCandidates([a, b], movie)[0].result).toBe(a);
    expect(rankCandidates([a, b], movie, ["a".repeat(40)])[0].result).toBe(b);
    expect(hashOfResult(b)).toBe("b".repeat(40));
  });
});
