import { route, HttpError } from "@/server/api";
import { searchTorrentsDetailed } from "@/server/torrents/search";

/** Torrent search for the Add Media wizard. Admin only; nothing is ever downloaded without an explicit add. */
export const GET = route(
  "admin",
  async ({ req }) => {
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length < 2) throw new HttpError(400, "Enter at least 2 characters");
    const cat = req.nextUrl.searchParams.get("category");
    return searchTorrentsDetailed(q.slice(0, 150), { category: cat === "movies" || cat === "tv" ? cat : "all", limit: 60 });
  },
  { rate: { key: "tsearch", max: 20, windowMs: 60_000 } },
);
