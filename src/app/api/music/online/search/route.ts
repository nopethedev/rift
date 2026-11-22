import { z } from "zod";
import { route, parse } from "@/server/api";
import { searchCatalog } from "@/server/music/online";
import { online } from "@/server/music/online-api";

export const dynamic = "force-dynamic";
export const GET = route("profile", async ({ req }) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(200) }), Object.fromEntries(req.nextUrl.searchParams));
  return online(() => searchCatalog(q));
}, { rate: { key: "music-catalog-search", max: 40, windowMs: 60_000 } });
