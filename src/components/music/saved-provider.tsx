"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../ui";
import { songKey, type ItemInput } from "@/lib/music-types";

interface Ctx {
  isSaved(artist: string, title: string): boolean;
  /** Save or un-save a song. Resolves to the new state; rejects (and rolls back) when the server refuses. */
  toggle(artist: string, title: string, input: ItemInput): Promise<boolean>;
  count: number;
  /** Bumped on every change so open lists can refresh. */
  version: number;
}
const C = createContext<Ctx | null>(null);
export const useSaved = () => useContext(C)!;

/** Which songs the profile saved ("Liked songs"), so every heart button knows its state without its own request. */
export function SavedProvider({ children }: { children: React.ReactNode }) {
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  // Toggles still in flight: the initial load must not overwrite them if it happens to arrive after a click.
  const inflight = useRef(new Map<string, boolean>());
  useEffect(() => {
    api<{ keys: string[] }>("/api/music/saved?keys=1").then((r) => {
      const n = new Set(r.keys);
      for (const [k, on] of inflight.current) { if (on) n.add(k); else n.delete(k); }
      setKeys(n);
    }).catch(() => {});
  }, []);
  const isSaved = useCallback((artist: string, title: string) => keys.has(songKey(artist, title)), [keys]);
  const toggle = useCallback(async (artist: string, title: string, input: ItemInput) => {
    const k = songKey(artist, title);
    const was = keys.has(k);
    const set = (on: boolean) => setKeys((cur) => { const n = new Set(cur); if (on) n.add(k); else n.delete(k); return n; });
    set(!was);
    inflight.current.set(k, !was);
    try {
      if (was) await api("/api/music/saved", { method: "DELETE", body: { key: k } });
      else await api("/api/music/saved", { method: "POST", body: input });
      setVersion((v) => v + 1);
      return !was;
    } catch (e) { set(was); throw e; } finally { inflight.current.delete(k); }
  }, [keys]);
  const value = useMemo<Ctx>(() => ({ isSaved, toggle, count: keys.size, version }), [isSaved, toggle, keys.size, version]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
