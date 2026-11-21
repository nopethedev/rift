"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CardItem } from "@/lib/types";
import { api } from "./ui";
import { HoverPreview } from "./hover-preview";

interface Ctx {
  inList: (item: Pick<CardItem, "type" | "tmdbId">) => boolean;
  toggleList: (item: Pick<CardItem, "type" | "tmdbId" | "title" | "posterPath">) => Promise<void>;
  openPreview: (item: CardItem, rect: DOMRect, sheet: boolean) => void;
  keepPreview: () => void;
  closePreview: (delay?: number) => void;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("AppProviders missing");
  return c;
};

interface PreviewState { item: CardItem; rect: DOMRect; sheet: boolean }

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const keepPreview = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const closePreview = useCallback((delay = 140) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPreview(null), delay);
  }, []);
  const openPreview = useCallback((item: CardItem, rect: DOMRect, sheet: boolean) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setPreview({ item, rect, sheet });
  }, []);

  const value = useMemo(() => ({ inList, toggleList, openPreview, keepPreview, closePreview }), [inList, toggleList, openPreview, keepPreview, closePreview]);

  return (
    <AppCtx.Provider value={value}>
      {children}
      {preview && <HoverPreview key={preview.item.key} {...preview} onClose={() => setPreview(null)} />}
    </AppCtx.Provider>
  );
}
