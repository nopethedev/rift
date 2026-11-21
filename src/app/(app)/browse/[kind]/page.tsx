import { notFound } from "next/navigation";
import { requireProfile } from "@/server/auth";
import { BrowseGrid } from "./grid";

const MOVIE_GENRES = [
  [28, "Action"], [12, "Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [99, "Documentary"], [18, "Drama"], [10751, "Family"],
  [14, "Fantasy"], [27, "Horror"], [9648, "Mystery"], [10749, "Romance"], [878, "Sci-Fi"], [53, "Thriller"], [37, "Western"],
] as const;
const TV_GENRES = [
  [10759, "Action & Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [99, "Documentary"], [18, "Drama"], [10751, "Family"],
  [9648, "Mystery"], [10765, "Sci-Fi & Fantasy"], [10768, "War & Politics"], [37, "Western"],
] as const;

export default async function BrowsePage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind !== "movies" && kind !== "tv") notFound();
  const { profile } = await requireProfile();
  const kids = profile.isKids;
  const genres = (kind === "movies" ? MOVIE_GENRES : TV_GENRES).filter(([id]) => !kids || [16, 10751].includes(id));
  return (
    <div className="px-4 pt-24 sm:px-12">
      <h1 className="mb-5 text-3xl font-bold">{kind === "movies" ? "Movies" : "TV Shows"}</h1>
      <BrowseGrid type={kind === "movies" ? "movie" : "tv"} genres={genres.map(([id, name]) => ({ id, name }))} />
    </div>
  );
}
