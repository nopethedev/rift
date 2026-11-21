import { describe, expect, it } from "vitest";
import { isSampleFile, isVideoFile, normalizeTitle, parseMediaFilename, titleSimilarity } from "./filename";

describe("parseMediaFilename — movies", () => {
  const cases: [string, { title: string; year?: number }][] = [
    ["The.Movie.2019.1080p.BluRay.x264-GRP.mkv", { title: "The Movie", year: 2019 }],
    ["Inception (2010).mkv", { title: "Inception", year: 2010 }],
    ["Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-EPSiLON.mkv", { title: "Blade Runner 2049", year: 2017 }],
    ["2001.A.Space.Odyssey.1968.REMASTERED.1080p.BluRay.x264.mkv", { title: "2001 A Space Odyssey", year: 1968 }],
    ["Movies/Parasite (2019)/Parasite.mkv", { title: "Parasite", year: 2019 }],
    ["The_Big_Lebowski_1998_720p.mp4", { title: "The Big Lebowski", year: 1998 }],
    ["Some Movie [2004] [1080p] [YTS.MX].mp4", { title: "Some Movie", year: 2004 }],
    ["Night of the Living Dead.mp4", { title: "Night of the Living Dead" }],
    ["Amelie.2001.FRENCH.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv", { title: "Amelie", year: 2001 }],
    ["Dune Part Two 2024 1080p WEBRip x265.mkv", { title: "Dune Part Two", year: 2024 }],
    ["Alien (1979)/movie.mkv", { title: "Alien", year: 1979 }],
    ["Heat.1995.Directors.Cut.1080p.mkv", { title: "Heat", year: 1995 }],
    ["Metropolis_1927_archive.ogv", { title: "Metropolis", year: 1927 }],
  ];
  for (const [input, want] of cases) {
    it(input, () => {
      const r = parseMediaFilename(input);
      expect(r.kind).toBe("movie");
      expect(r.title).toBe(want.title);
      expect(r.year).toBe(want.year);
    });
  }
});

describe("parseMediaFilename — episodes", () => {
  const cases: [string, { title: string; season: number; episode: number; episodeEnd?: number; year?: number }][] = [
    ["Show.Name.S01E02.1080p.WEB-DL.x264-GRP.mkv", { title: "Show Name", season: 1, episode: 2 }],
    ["Show Name - S01E02 - The Title.mkv", { title: "Show Name", season: 1, episode: 2 }],
    ["Show Name - 1x02 - The Title.mkv", { title: "Show Name", season: 1, episode: 2 }],
    ["Show Name/Season 1/Episode 02.mkv", { title: "Show Name", season: 1, episode: 2 }],
    ["Show Name/Season 2/05 - Something.mkv", { title: "Show Name", season: 2, episode: 5 }],
    ["Show.Name.S01E01E02.720p.HDTV.mkv", { title: "Show Name", season: 1, episode: 1, episodeEnd: 2 }],
    ["Show.Name.S01E01-E03.720p.mkv", { title: "Show Name", season: 1, episode: 1, episodeEnd: 3 }],
    ["Show Name S03E10-11.mkv", { title: "Show Name", season: 3, episode: 10, episodeEnd: 11 }],
    ["The Office (US)/Season 03/The.Office.US.S03E05.mkv", { title: "The Office US", season: 3, episode: 5 }],
    ["Breaking Bad/S02/S02E04.mkv", { title: "Breaking Bad", season: 2, episode: 4 }],
    ["doctor_who_2005_s10e01_the_pilot.mp4", { title: "doctor who", season: 10, episode: 1, year: 2005 }],
    ["Show Name (2019) - S01E01 - Pilot.mkv", { title: "Show Name", season: 1, episode: 1, year: 2019 }],
    ["Some Show/Specials/S00E01.mkv", { title: "Some Show", season: 0, episode: 1 }],
    ["[SubGroup] Anime Name - 05 [1080p].mkv", { title: "Anime Name", season: 1, episode: 5 }],
    ["Show Name/Season 4/Show Name - Season 4 Episode 7.mkv", { title: "Show Name", season: 4, episode: 7 }],
    ["Mr. Robot - S02E03.mkv", { title: "Mr. Robot", season: 2, episode: 3 }],
    ["show.name.s1e9.mkv", { title: "show name", season: 1, episode: 9 }],
    ["Show Name/Season 1/Show.Name.E07.mkv", { title: "Show Name", season: 1, episode: 7 }],
  ];
  for (const [input, want] of cases) {
    it(input, () => {
      const r = parseMediaFilename(input);
      expect(r.kind).toBe("episode");
      expect(r.title).toBe(want.title);
      expect(r.season).toBe(want.season);
      expect(r.episode).toBe(want.episode);
      expect(r.episodeEnd).toBe(want.episodeEnd);
      if (want.year) expect(r.year).toBe(want.year);
    });
  }

  it("does not mistake a resolution for 1x02", () => {
    const r = parseMediaFilename("Movie.Name.2012.1920x1080.mkv");
    expect(r.kind).toBe("movie");
    expect(r.title).toBe("Movie Name");
  });

  it("windows separators", () => {
    const r = parseMediaFilename("Show Name\\Season 3\\03.mkv");
    expect(r).toMatchObject({ kind: "episode", title: "Show Name", season: 3, episode: 3 });
  });
});

describe("helpers", () => {
  it("isVideoFile", () => {
    for (const f of ["a.mkv", "a.MP4", "x/y.m4v", "a.mov", "a.avi", "a.webm", "a.ts", "a.m2ts", "a.wmv", "a.flv", "a.mpg", "a.mpeg", "a.ogv"]) expect(isVideoFile(f)).toBe(true);
    for (const f of ["a.srt", "a.nfo", "a.part", "a.mkv.part", "mkv", "a.jpg", "a.txt"]) expect(isVideoFile(f)).toBe(false);
  });
  it("isSampleFile", () => {
    expect(isSampleFile("Movie.2019.1080p-sample.mkv")).toBe(true);
    expect(isSampleFile("Movie/Sample/movie.mkv")).toBe(true);
    expect(isSampleFile("sample.mkv")).toBe(true);
    expect(isSampleFile("Movie.2019.SAMPLE.mkv")).toBe(true);
    expect(isSampleFile("The Sampler (2020).mkv")).toBe(false);
    expect(isSampleFile("Samples of Life/ep.mkv".replace("Samples of Life", "Life"))).toBe(false);
  });
  it("normalizeTitle / titleSimilarity", () => {
    expect(normalizeTitle("The Lord of the Rings: The Return of the King")).toBe("lord of the rings the return of the king");
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(titleSimilarity("Inception", "inception")).toBe(1);
    expect(titleSimilarity("The Office US", "The Office")).toBeGreaterThan(0.7);
    expect(titleSimilarity("Alien", "Aliens vs Predator Requiem")).toBeLessThan(0.5);
  });
});
