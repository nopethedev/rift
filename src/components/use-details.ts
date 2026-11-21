"use client";
import { useEffect, useState } from "react";
import type { CardItem } from "@/lib/types";

export interface Details {
  year: number | null; runtime: number | null; seasons: number | null; rating: number | null; certification: string | null;
  genres: string[]; overview: string; trailerKey: string | null; backdropPath: string | null; available: boolean; playFileId: string | null;
}

const cache = new Map<string, Details | null>();

/** Title details (trailer, genres, certification…) from /api/tmdb/details; cached for the session. Fetches only while `enabled`. */
export function useDetails(item: Pick<CardItem, "type" | "tmdbId">, enabled = true) {
  const key = `${item.type}-${item.tmdbId}`;
  const [d, setD] = useState<Details | null | undefined>(cache.get(key));
  useEffect(() => {
    if (!enabled || !item.tmdbId || cache.has(key)) { if (cache.has(key)) setD(cache.get(key)); return; }
    let live = true;
    fetch(`/api/tmdb/details?type=${item.type}&id=${item.tmdbId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((v) => { cache.set(key, v); if (live) setD(v); });
    return () => { live = false; };
  }, [key, item.tmdbId, item.type, enabled]);
  return d;
}

export const trailerSrc = (key: string) =>
  `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${key}&iv_load_policy=3&disablekb=1`;
