import { describe, expect, it } from "vitest";
import { buildTaste, contextOf, pickDiverse, playWeight, scoreTracks, songKey, splitArtists, type PlaySignal, type TasteInput } from "./music-taste";

const play = (artist: string, title: string, o: Partial<PlaySignal> = {}): PlaySignal => ({ artist, title, playedSec: 200, durationSec: 200, completed: true, ageDays: 3, ...o });
const empty: TasteInput = { plays: [], likes: [], playlisted: [], picks: { artists: [], genres: [] } };
const zero = () => 0;

describe("taste profile", () => {
  it("weighs finished plays over partial ones; quick skips count against the song", () => {
    expect(playWeight({ completed: true, playedSec: 10, durationSec: 200 })).toBe(1);
    expect(playWeight({ completed: false, playedSec: 100, durationSec: 200 })).toBeCloseTo(0.65);
    expect(playWeight({ completed: false, playedSec: 8, durationSec: 200 })).toBeLessThan(0);
  });

  it("ranks artists by listening, likes and picks; picks fade as history grows", () => {
    const t = buildTaste({ ...empty, plays: [play("Daft Punk", "One More Time"), play("Daft Punk", "Aerodynamic"), play("Justice", "D.A.N.C.E.", { completed: false, playedSec: 100 })], likes: [{ artist: "Air", title: "La femme d'argent", ageDays: 10 }], picks: { artists: ["Phoenix"], genres: ["Electro"] } });
    expect(t.artists.map((a) => a.name).slice(0, 3)).toEqual(["Phoenix", "Air", "Daft Punk"]); // a fresh pick is strong, a like beats two plays...
    const many = Array.from({ length: 60 }, (_, i) => play("Daft Punk", `Song ${i}`, { ageDays: 1 + (i % 20) }));
    const later = buildTaste({ ...empty, plays: many, picks: { artists: ["Phoenix"], genres: [] } });
    expect(later.artists[0].name).toBe("Daft Punk"); // ...until real listening takes over
    expect(later.learned).toBe(1);
    expect(t.genres[0].name).toBe("Electro");
  });

  it("old plays fade; featured artists count half; skipped artists are avoided", () => {
    const t = buildTaste({ ...empty, plays: [play("Old Band", "x", { ageDays: 400 }), play("New Band feat. Guest", "y")] });
    expect(t.artists[0].name).toBe("New Band");
    expect(t.artists.find((a) => a.name === "Guest")!.score).toBeLessThan(1);
    const skips = Array.from({ length: 12 }, (_, i) => play("Nope", `s${i}`, { completed: false, playedSec: 5, ageDays: 2 + i }));
    expect(buildTaste({ ...empty, plays: [...Array.from({ length: 30 }, (_, i) => play("Filler", `f${i}`)), ...skips] }).avoid.has("nope")).toBe(true);
    expect(splitArtists("A, B ft. C & D")).toEqual(["A", "B", "C & D"]);
  });
});

describe("matching", () => {
  const taste = buildTaste({ ...empty, plays: [play("Daft Punk", "One More Time", { genre: "Electro", year: 2001 }), play("Daft Punk", "Digital Love", { genre: "Electro", year: 2001 }), play("Adele", "Hello", { ageDays: 30 })] });

  it("prefers known artists, then artists related to them; drops just-played songs; explains why", () => {
    const m = scoreTracks(taste, [
      { item: "related", c: { artist: "Justice", title: "Genesis", related: [{ to: "Daft Punk", strength: 0.9 }] } },
      { item: "known", c: { artist: "Daft Punk", title: "Harder Better" } },
      { item: "stranger", c: { artist: "Nobody", title: "Noise" } },
      { item: "recent", c: { artist: "Daft Punk", title: "One More Time" } },
    ]).sort((a, b) => b.score - a.score);
    expect(m.map((x) => x.item)).toEqual(["known", "related", "stranger"]);
    expect(m[0].reason).toBe("You listen to Daft Punk");
    expect(m[1].reason).toBe("Similar to Daft Punk");
    expect(m[2].reason).toBe("Something new");
  });

  it("a context (playlist) pulls its own artists up", () => {
    const ctx = contextOf([{ artist: "Adele" }, { artist: "Adele" }, { artist: "Sam Smith" }], 1.2, 0.4);
    const m = scoreTracks(taste, [{ item: "dp", c: { artist: "Daft Punk", title: "Robot Rock" } }, { item: "sam", c: { artist: "Sam Smith", title: "Stay With Me" } }], ctx).sort((a, b) => b.score - a.score);
    expect(m[0].item).toBe("sam");
    expect(m[0].reason).toBe("More Sam Smith");
  });

  it("skipped songs sink", () => {
    const t = buildTaste({ ...empty, plays: [...Array.from({ length: 31 }, (_, i) => play("Filler", `f${i}`)), play("Daft Punk", "Too Long", { completed: false, playedSec: 3 }), play("Daft Punk", "Around the World")] });
    const m = scoreTracks(t, [{ item: "skipped", c: { artist: "Daft Punk", title: "Too Long" } }, { item: "fine", c: { artist: "Daft Punk", title: "Crescendolls" } }]);
    expect(m.find((x) => x.item === "skipped")!.score).toBeLessThan(m.find((x) => x.item === "fine")!.score);
  });

  it("pickDiverse spreads artists and never repeats a song", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => ({ item: `dp${i}`, c: { artist: "Daft Punk", title: `t${i}` } })), { item: "j", c: { artist: "Justice", title: "x", related: [{ to: "Daft Punk", strength: 0.8 }] } }, { item: "j2", c: { artist: "Justice", title: "x" } }];
    const picked = pickDiverse(scoreTracks(taste, items), 5, { rand: zero });
    expect(picked.filter((p) => p.artistKey === "daft punk")).toHaveLength(2);
    expect(picked.filter((p) => p.songKey === songKey("Justice", "x"))).toHaveLength(1);
    for (let i = 1; i < picked.length; i++) if (picked.length > 2) expect(picked[i].artistKey === picked[i - 1].artistKey && i < 2).toBe(false);
  });
});
