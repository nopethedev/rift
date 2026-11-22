"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { CardItem } from "@/lib/types";
import { PosterCard, PosterSkeleton } from "@/components/poster-card";
import { Select } from "@/components/ui";

export function BrowseGrid({ type, genres }: { type: "movie" | "tv"; genres: { id: number; name: string }[] }) {
  const [genre, setGenre] = useState<number | null>(null);
  const [sort, setSort] = useState("popularity.desc");
  const [items, setItems] = useState<CardItem[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);
  const gen = useRef(0);

  const load = useCallback(async (p: number, reset: boolean) => {
    const id = ++gen.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ type, page: String(p), sort });
      if (genre) qs.set("genre", String(genre));
      const res = await fetch(`/api/tmdb/discover?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (id !== gen.current) return;
      setItems((cur) => (reset ? data.items : [...cur, ...data.items.filter((n: CardItem) => !cur.some((c) => c.key === n.key))]));
      setPage(p);
      setPages(data.totalPages);
      setError("");
    } catch (e) {
      if (id === gen.current) setError((e as Error).message);
    } finally {
      if (id === gen.current) setLoading(false);
    }
  }, [type, genre, sort]);

  useEffect(() => { setItems([]); load(1, true); }, [load]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && !loading && page < pages && !error) load(page + 1, false); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, page, pages, load, error]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button onClick={() => setGenre(null)} className={clsx("rounded-full px-4 py-2.5 text-sm transition pointer-fine:py-1.5", genre === null ? "bg-accent text-white" : "bg-white/10 hover:bg-white/20")}>All</button>
        {genres.map((g) => (
          <button key={g.id} onClick={() => setGenre(g.id)} className={clsx("rounded-full px-4 py-2.5 text-sm transition pointer-fine:py-1.5", genre === g.id ? "bg-accent text-white" : "bg-white/10 hover:bg-white/20")}>{g.name}</button>
        ))}
        <div className="ml-auto w-44">
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="popularity.desc">Popular</option>
            <option value="vote_average.desc">Top rated</option>
            <option value={type === "movie" ? "primary_release_date.desc" : "first_air_date.desc"}>Newest</option>
          </Select>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-500/10 p-4 text-sm text-red-300">{error}</p>}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((i) => <PosterCard key={i.key} item={i} />)}
        {loading && Array.from({ length: 12 }).map((_, i) => <PosterSkeleton key={`s${i}`} />)}
      </div>
      <div ref={sentinel} className="h-10" />
    </>
  );
}
