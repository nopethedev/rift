import { Suspense } from "react";
import Link from "next/link";
import { Film, KeyRound, Sparkles } from "lucide-react";
import { requireProfile } from "@/server/auth";
import { requireAppChoice } from "@/server/app-choice";
import { db } from "@/server/db";
import { tasteRows } from "@/server/taste";
import { parseFavoriteGenres, sinceParam } from "@/lib/taste";
import { tmdbConfigured } from "@/server/tmdb";
import { continueWatching, myList, recentlyAdded, recommendations, tmdbRow } from "@/server/catalog";
import { Hero } from "@/components/hero";
import { Row, RowSkeleton } from "@/components/row";
import type { CardItem } from "@/lib/types";

export const metadata = { title: "Home" };
export const dynamic = "force-dynamic";

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

async function HeroSection({ kids, local }: { kids: boolean; local: Promise<CardItem[]> }) {
  const trending = kids
    ? await safe(tmdbRow("/discover/movie", { with_genres: "16|10751", sort_by: "popularity.desc", "certification.lte": "PG", certification_country: "US" }, "movie"), [])
    : await safe(tmdbRow("/trending/all/week"), []);
  const pool = trending.filter((c) => c.backdropPath && c.overview);
  // Prefer titles that are in the library, then fill with discovery
  const items = [...pool.filter((c) => c.available), ...pool.filter((c) => !c.available)].slice(0, 6);
  if (!items.length) {
    const l = (await local).filter((c) => c.backdropPath).slice(0, 5);
    if (!l.length) return <div className="h-24" />;
    return <Hero items={l} />;
  }
  return <Hero items={items} />;
}

async function AsyncRow({ title, load, href }: { title: string; load: Promise<CardItem[]>; href?: string }) {
  const items = await safe(load, []);
  return <Row title={title} items={items} href={href} />;
}

async function RecoRows({ profileId }: { profileId: string }) {
  const rows = await safe(recommendations(profileId, 2), []);
  return <>{rows.map((r) => <Row key={r.title} title={r.title} items={r.items} />)}</>;
}

/** Rows from the profile's taste: its picked genres, watch history and My List (see src/lib/taste.ts). */
async function TasteRows({ profileId, name }: { profileId: string; name: string }) {
  const [rows, row] = await Promise.all([safe(tasteRows(profileId, name), []), db.profile.findUnique({ where: { id: profileId }, select: { favoriteGenres: true } })]);
  const picked = parseFavoriteGenres(row?.favoriteGenres).length > 0;
  return (
    <>
      {rows.map((r) => <Row key={r.title} title={r.title} items={r.items} />)}
      {!picked && !rows.length && (
        <Link href="/profiles?manage=1" className="mx-4 flex items-center gap-3 rounded-xl border border-dashed border-accent/40 bg-accent/5 px-4 py-3 text-sm transition hover:bg-accent/10 sm:mx-12">
          <Sparkles className="size-5 shrink-0 text-accent" />
          <span><span className="font-semibold">Personalise Rift.</span> <span className="text-muted">Pick 3 genres you like and your home page starts recommending them.</span></span>
        </Link>
      )}
    </>
  );
}

const GENRE_ROWS = [
  { title: "Action Movies", type: "movie", g: 28 },
  { title: "Sci-Fi & Fantasy", type: "movie", g: "878,14" },
  { title: "Comedies", type: "movie", g: 35 },
  { title: "Crime Dramas", type: "tv", g: 80 },
  { title: "Documentaries", type: "movie", g: 99 },
  { title: "Horror", type: "movie", g: 27 },
] as const;

export default async function HomePage() {
  const { profile } = await requireProfile();
  await requireAppChoice();
  const configured = await tmdbConfigured();
  const local = recentlyAdded(24);
  const cont = continueWatching(profile.id);
  const list = myList(profile.id);

  const sk = <RowSkeleton />;
  return (
    <>
      <Suspense fallback={<div className="skeleton h-[68vh] min-h-[32rem] w-full !rounded-none sm:h-[80vh] sm:min-h-[40rem]" />}>
        <HeroSection kids={profile.isKids} local={local} />
      </Suspense>
      <div className="relative z-10 -mt-16 space-y-8 sm:-mt-24">
        <Suspense fallback={null}><AsyncRow title="Continue Watching" load={cont} /></Suspense>
        <Suspense fallback={null}><AsyncRow title="My List" load={list} /></Suspense>
        <Suspense fallback={sk}><AsyncRow title="Recently Added to Your Library" load={local} /></Suspense>
        {!profile.isKids && <Suspense fallback={null}><TasteRows profileId={profile.id} name={profile.name} /></Suspense>}
        {configured ? (
          profile.isKids ? (
            <>
              <Suspense fallback={sk}><AsyncRow title="Family Movies" load={tmdbRow("/discover/movie", { with_genres: "10751", certification_country: "US", "certification.lte": "PG", sort_by: "popularity.desc" }, "movie")} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Animation" load={tmdbRow("/discover/movie", { with_genres: "16", certification_country: "US", "certification.lte": "PG", sort_by: "popularity.desc" }, "movie")} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Kids TV" load={tmdbRow("/discover/tv", { with_genres: "10762", sort_by: "popularity.desc" }, "tv")} /></Suspense>
            </>
          ) : (
            <>
              <Suspense fallback={null}><RecoRows profileId={profile.id} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Trending This Week" load={tmdbRow("/trending/all/week")} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Popular Movies" load={tmdbRow("/movie/popular", {}, "movie")} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Popular TV Shows" load={tmdbRow("/tv/popular", {}, "tv")} /></Suspense>
              <Suspense fallback={sk}><AsyncRow title="Top Rated Movies of the Last 15 Years" load={tmdbRow("/discover/movie", { sort_by: "vote_average.desc", "vote_count.gte": 2000, ...sinceParam("movie", 15) }, "movie")} /></Suspense>
              {GENRE_ROWS.map((g) => (
                <Suspense key={g.title} fallback={sk}>
                  <AsyncRow title={g.title} load={tmdbRow(`/discover/${g.type}`, { with_genres: String(g.g).replace(",", "|"), sort_by: "popularity.desc", "vote_count.gte": 200, ...sinceParam(g.type, 15) }, g.type)} />
                </Suspense>
              ))}
            </>
          )
        ) : (
          <EmptyState />
        )}
      </div>
    </>
  );
}

async function EmptyState() {
  const { user } = await requireProfile();
  return (
    <div className="mx-4 mt-10 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-14 text-center sm:mx-12">
      <KeyRound className="size-10 text-accent" />
      <h2 className="text-xl font-bold">Discovery is off</h2>
      <p className="max-w-md text-sm text-muted">Add a TMDB API key to unlock trending titles, genres, trailers and metadata matching for your own media.</p>
      {user.role === "ADMIN" ? (
        <Link href="/admin/settings" className="btn-primary inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold"><Film className="size-4" /> Open settings</Link>
      ) : (
        <p className="text-sm text-muted">Ask your administrator to configure it.</p>
      )}
    </div>
  );
}
