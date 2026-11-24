"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, MicVocal } from "lucide-react";
import { api } from "../ui";
import type { Lyrics, LyricsResult } from "@/lib/music-types";
import { useMusic } from "./player-provider";

// ---- lookup, cached for the life of the page ----
const cache = new Map<string, LyricsResult>();
const inflight = new Map<string, Promise<LyricsResult>>();
const keyOf = (t: { title: string; artist: string }) => `${t.artist.toLowerCase()}|${t.title.toLowerCase()}`;

function load(t: { title: string; artist: string; durationSec?: number | null }): Promise<LyricsResult> {
  const k = keyOf(t);
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    const q = new URLSearchParams({ title: t.title, artist: t.artist, ...(t.durationSec ? { durationSec: String(Math.round(t.durationSec)) } : {}) });
    p = api<LyricsResult>(`/api/music/lyrics?${q}`)
      .then((r) => { cache.set(k, r); return r; })
      .catch((e: Error) => ({ lyrics: null, reason: e.message }))
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

export type LyricsState = { state: "loading" } | { state: "ready"; lyrics: Lyrics } | { state: "none"; reason: string };

/** Lyrics of whatever is playing now. */
export function useLyrics(): LyricsState | null {
  const { current } = useMusic();
  const [st, setSt] = useState<{ key: string; v: LyricsState } | null>(null);
  const k = current ? keyOf(current) : null;
  useEffect(() => {
    if (!current || !k) return;
    let live = true;
    void load(current).then((r) => { if (live) setSt({ key: k, v: r.lyrics ? { state: "ready", lyrics: r.lyrics } : { state: "none", reason: r.reason ?? "No lyrics found for this song." } }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per song, not per queue-item object
  }, [k]);
  if (!current) return null;
  return st?.key === k ? st.v : { state: "loading" };
}

/** Index of the line being sung at `ms` (-1 before the first line). */
export function activeLine(lines: { t: number }[], ms: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** Synced lyrics follow the song (the current line is highlighted and kept in view; click a line to jump there). */
export function LyricsView({ className, size = "lg" }: { className?: string; size?: "sm" | "lg" }) {
  const l = useLyrics();
  const { position, seek } = useMusic();
  const box = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(0);
  const lines = useMemo(() => (l?.state === "ready" && l.lyrics.synced ? l.lyrics.lines : []), [l]);
  const idx = lines.length ? activeLine(lines, position * 1000 + 250) : -1;

  useEffect(() => {
    const el = box.current;
    if (!el || idx < 0 || Date.now() - userScrolled.current < 4000) return;
    const row = el.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    if (row) el.scrollTo({ top: row.offsetTop - el.clientHeight / 2 + row.clientHeight / 2, behavior: "smooth" });
  }, [idx]);

  if (!l) return null;
  const text = size === "lg" ? "text-2xl sm:text-3xl" : "text-lg";
  return (
    <div
      ref={box}
      data-testid="lyrics"
      onWheel={() => (userScrolled.current = Date.now())}
      onTouchMove={() => (userScrolled.current = Date.now())}
      className={clsx("no-scrollbar relative overflow-y-auto", className)}
    >
      {l.state === "loading" && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Looking for lyrics…</p>}
      {l.state === "none" && <p className="flex items-start gap-2 text-sm text-muted"><MicVocal className="mt-0.5 size-4 shrink-0" /><span>{l.reason}</span></p>}
      {l.state === "ready" && (
        <>
          {lines.length ? (
            <ol className={clsx("space-y-3 py-[30%] font-extrabold leading-snug", text)}>
              {lines.map((ln, i) => (
                <li key={i} data-line={i}>
                  <button
                    onClick={() => { userScrolled.current = 0; seek(ln.t / 1000); }}
                    className={clsx("text-left transition-colors", i === idx ? "text-white" : i < idx ? "text-white/45 hover:text-white/80" : "text-white/30 hover:text-white/70")}
                  >{ln.text || "♪"}</button>
                </li>
              ))}
            </ol>
          ) : (
            <p className={clsx("whitespace-pre-line font-bold leading-relaxed text-white/85", size === "lg" ? "text-xl" : "text-base")}>{l.lyrics.text}</p>
          )}
          {(l.lyrics.provider || l.lyrics.source) && <p className="mt-4 text-[11px] text-muted">Lyrics provided by {l.lyrics.provider ?? l.lyrics.source}{!l.lyrics.synced ? " · not time-synced" : ""}</p>}
        </>
      )}
    </div>
  );
}

/** Small "Lyrics" card for the side panel: a few lines around the current one. */
export function LyricsCard({ onOpen }: { onOpen?: () => void }) {
  const l = useLyrics();
  if (!l || l.state === "none") return null;
  return (
    <section aria-label="Lyrics" className="rounded-xl bg-violet-950/60 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold">Lyrics</h3>
        {onOpen && l.state === "ready" && <button onClick={onOpen} className="text-xs font-semibold text-white/70 hover:text-white">Show full</button>}
      </div>
      <LyricsView size="sm" className="max-h-72" />
    </section>
  );
}
