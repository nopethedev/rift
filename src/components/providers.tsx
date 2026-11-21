"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CardItem } from "@/lib/types";
import { api } from "./ui";
import { PreviewSheet } from "./hover-preview";

interface Ctx {
  inList: (item: Pick<CardItem, "type" | "tmdbId">) => boolean;
  toggleList: (item: Pick<CardItem, "type" | "tmdbId" | "title" | "posterPath">) => Promise<void>;
  /** Touch: open the bottom sheet (trailer + actions) for a card. */
  openSheet: (item: CardItem) => void;
  /** On-demand streaming (torrent) is available to this account. */
  onDemand: boolean;
  /** Start an on-demand stream for a title that is not in the library. */
  playOnDemand: (item: Pick<CardItem, "type" | "tmdbId">, season?: number, episode?: number) => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("AppProviders missing");
  return c;
};


export function AppProviders({ children, onDemand = false }: { children: React.ReactNode; onDemand?: boolean }) {
  const router = useRouter();
  const [list, setList] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<CardItem | null>(null);

  useEffect(() => {
    api<{ items: { tmdbId: number; mediaType: string }[] }>("/api/watchlist")
      .then((r) => setList(new Set(r.items.map((i) => `${i.mediaType}-${i.tmdbId}`))))
      .catch(() => {});
  }, []);

  const inList = useCallback((i: Pick<CardItem, "type" | "tmdbId">) => !!i.tmdbId && list.has(`${i.type}-${i.tmdbId}`), [list]);

  const toggleList = useCallback<Ctx["toggleList"]>(
    async (i) => {
      if (!i.tmdbId) return;
      const key = `${i.type}-${i.tmdbId}`;
      const had = list.has(key);
      setList((s) => {
        const n = new Set(s);
        if (had) n.delete(key); else n.add(key);
        return n;
      });
      try {
        await api("/api/watchlist", { method: had ? "DELETE" : "POST", body: { tmdbId: i.tmdbId, mediaType: i.type, title: i.title, posterPath: i.posterPath } });
      } catch {
        setList((s) => {
          const n = new Set(s);
          if (had) n.add(key); else n.delete(key);
          return n;
        });
      }
    },
    [list],
  );

  const openSheet = useCallback((item: CardItem) => setSheet(item), []);

  const playOnDemand = useCallback<Ctx["playOnDemand"]>((i, season, episode) => {
    if (!i.tmdbId) return;
    const q = new URLSearchParams({ type: i.type, tmdbId: String(i.tmdbId) });
    if (i.type === "tv") { q.set("season", String(season ?? 1)); q.set("episode", String(episode ?? 1)); }
    setSheet(null);
    router.push(`/stream/start?${q}`);
  }, [router]);

  const value = useMemo(() => ({ inList, toggleList, openSheet, onDemand, playOnDemand }), [inList, toggleList, openSheet, onDemand, playOnDemand]);

  return (
    <AppCtx.Provider value={value}>
      {children}
      {sheet && <PreviewSheet key={sheet.key} item={sheet} onClose={() => setSheet(null)} />}
    </AppCtx.Provider>
  );
}
