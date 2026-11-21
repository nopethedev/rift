"use client";
import { useEffect, useState } from "react";
import { Library, Search, Telescope } from "lucide-react";
import type { CardItem } from "@/lib/types";
import { PosterCard, PosterSkeleton } from "@/components/poster-card";

interface Data { local: CardItem[]; discover: CardItem[]; tmdb: boolean }

export function SearchResults({ q }: { q: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) { setData(null); return; }
    const ctl = new AbortController();
    setData(null);
    setErr("");
    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); })
      .then(setData)
      .catch((e) => e.name !== "AbortError" && setErr(e.message));
    return () => ctl.abort();
  }, [q]);

  if (q.trim().length < 2) {
    return <div className="flex flex-col items-center gap-3 py-24 text-muted"><Search className="size-10" /><p>Search your library and everything on TMDB.</p></div>;
  }
  if (err) return <p className="py-10 text-red-300">{err}</p>;
  if (!data) {
    return <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">{Array.from({ length: 16 }).map((_, i) => <PosterSkeleton key={i} />)}</div>;
  }
  const grid = "grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8";
  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-bold">Results for “{q}”</h1>
      {data.local.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Library className="size-5 text-accent" /> In your library</h2>
          <div className={grid}>{data.local.map((i) => <PosterCard key={i.key} item={i} />)}</div>
        </section>
      )}
      {data.discover.length > 0 && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Telescope className="size-5 text-white/60" /> Discover</h2>
          <div className={grid}>{data.discover.map((i) => <PosterCard key={i.key} item={i} />)}</div>
        </section>
      )}
      {!data.local.length && !data.discover.length && <p className="py-16 text-center text-muted">No results.{!data.tmdb && " TMDB is not configured, so only your library is searched."}</p>}
    </div>
  );
}
