import { route } from "@/server/api";
import { genreSamples } from "@/server/taste";
import { PICK_COUNT, TASTE_GENRES } from "@/lib/taste";

/** Genres for the "what do you like?" step, with a few sample posters each (when TMDB is configured). */
export const GET = route("user", async () => {
  const samples = await genreSamples();
  return { pick: PICK_COUNT, genres: TASTE_GENRES.map((g) => ({ key: g.key, label: g.label, from: g.from, to: g.to, posters: samples[g.key] ?? [] })) };
});
