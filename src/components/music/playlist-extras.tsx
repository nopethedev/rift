"use client";
// Below a playlist: a search to add songs to it, and songs recommended for it (like what's in it, ranked by taste).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, Input } from "@/components/ui";
import { songKey } from "@/lib/music-taste";
import { SEARCH_DELAY_MS } from "@/lib/use-debounced";
import { catInput, type Candidate, type CatTrack, type ItemInput, type TrackDTO } from "@/lib/music-types";
import { candidateRow, SectionTitle, TrackRow, trackRow, type RowItem } from "./parts";
import { useMusic } from "./player-provider";

interface Rec { key: string; input: ItemInput; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; trackId: string | null; reason: string }

function AddButton({ added, busy, onAdd, title }: { added: boolean; busy: boolean; onAdd: () => void; title: string }) {
  return (
    <button
      onClick={onAdd} disabled={added || busy} aria-label={added ? `${title} added` : `Add ${title} to this playlist`}
      className="inline-flex min-w-16 items-center justify-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs font-semibold text-white hover:border-white hover:bg-white/5 disabled:border-transparent disabled:text-emerald-300"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : added ? <><Check className="size-3.5" /> Added</> : "Add"}
    </button>
  );
}

function useAdder(playlistId: string, onAdded: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const add = useCallback(async (key: string, input: ItemInput) => {
    setBusy(key); setErr("");
    try {
      await api(`/api/music/playlists/${playlistId}/items`, { method: "POST", body: { items: [input] } });
      setAdded((s) => new Set(s).add(key));
      onAdded();
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  }, [playlistId, onAdded]);
  return { busy, added, err, add };
}

export interface FinderHandle { open(): void }

/** "Find songs for this playlist": library, catalogue and on-demand results, 1 s after typing stops. */
export const PlaylistFinder = forwardRef<FinderHandle, { playlistId: string; inPlaylist: Set<string>; onAdded: () => void; startOpen: boolean }>(function PlaylistFinder({ playlistId, inPlaylist, onAdded, startOpen }, ref) {
  const { mode, playItems } = useMusic();
  const [open, setOpen] = useState(startOpen);
  const [q, setQ] = useState("");
  const [now, setNow] = useState(0);
  const [res, setRes] = useState<{ loading: boolean; rows: RowItem[]; od: "idle" | "loading" | "done" }>({ loading: false, rows: [], od: "idle" });
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { busy, added, err, add } = useAdder(playlistId, onAdded);
  useImperativeHandle(ref, () => ({ open() { setOpen(true); setTimeout(() => { box.current?.scrollIntoView({ behavior: "smooth", block: "start" }); input.current?.focus({ preventScroll: true }); }, 50); } }), []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes({ loading: false, rows: [], od: "idle" }); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setRes((r) => ({ ...r, loading: true }));
      const enc = encodeURIComponent(term);
      const [lib, cat] = await Promise.all([
        api<{ tracks: TrackDTO[] }>(`/api/music/search?q=${enc}`, { signal: ctl.signal }).then((r) => r.tracks.slice(0, 8)).catch(() => [] as TrackDTO[]),
        api<{ tracks: CatTrack[] }>(`/api/music/online/search?q=${enc}`, { signal: ctl.signal }).then((r) => r.tracks.slice(0, 12)).catch(() => [] as CatTrack[]),
      ]);
      if (ctl.signal.aborted) return;
      const seen = new Set<string>();
      const rows: RowItem[] = [];
      const push = (r: RowItem) => { const k = songKey(r.artist, r.title); if (seen.has(k)) return; seen.add(k); rows.push(r); };
      lib.forEach((t) => push(trackRow(t)));
      if (mode?.onDemand) cat.forEach((t) => push({ key: `dz:${t.id}`, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.artworkUrl }));
      setRes({ loading: false, rows, od: mode?.onDemand && rows.length < 4 ? "loading" : "done" });
      // Only when the catalogue had little: the slower on-demand sources (YouTube/SoundCloud/Lavalink).
      if (mode?.onDemand && rows.length < 4) {
        const od = await api<{ candidates: Candidate[] }>(`/api/music/search/ondemand?q=${enc}`, { signal: ctl.signal }).then((r) => r.candidates).catch(() => [] as Candidate[]);
        if (ctl.signal.aborted) return;
        od.forEach((c) => push(candidateRow(c)));
        setRes({ loading: false, rows: [...rows], od: "done" });
      }
    }, now ? 0 : SEARCH_DELAY_MS);
    return () => { ctl.abort(); clearTimeout(t); };
  }, [q, now, mode?.onDemand]);

  if (!open) return null;
  return (
    <section ref={box} aria-label="Find songs for this playlist" className="mt-8 scroll-mt-20 border-t border-white/10 pt-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Find songs for this playlist</h2>
          <p className="text-xs text-muted">{mode?.onDemand ? "Your library and the catalogue." : "Your library."}</p>
        </div>
        <button onClick={() => { setOpen(false); setQ(""); }} aria-label="Close search" className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
      </div>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input ref={input} aria-label="Search for songs to add" placeholder="Song or artist" enterKeyHint="search" value={q} onChange={(e) => { setNow(0); setQ(e.target.value); }} onKeyDown={(e) => e.key === "Enter" && setNow(Date.now())} className="pl-10" />
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-red-300">{err}</p>}
      <div className="mt-3">
        {res.loading && <p className="flex items-center gap-2 py-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Searching…</p>}
        {res.rows.map((r) => {
          const inside = inPlaylist.has(songKey(r.artist, r.title)) || added.has(r.key);
          return <TrackRow key={r.key} item={r} onPlay={() => void playItems([r.input], { startIndex: 0 })} extra={<AddButton title={r.title} added={inside} busy={busy === r.key} onAdd={() => void add(r.key, r.input)} />} />;
        })}
        {res.od === "loading" && !res.loading && <p className="flex items-center gap-2 py-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Looking in on-demand sources…</p>}
        {!res.loading && res.od === "done" && q.trim().length >= 2 && !res.rows.length && <p className="py-3 text-sm text-muted">Nothing found for “{q.trim()}”.</p>}
      </div>
    </section>
  );
});

/** Spotify-style "Recommended" at the end of a playlist, with Refresh. */
export function PlaylistRecommendations({ playlistId, onAdded, empty, inPlaylist }: { playlistId: string; onAdded: () => void; empty: boolean; inPlaylist: Set<string> }) {
  const { mode, playItems } = useMusic();
  const [items, setItems] = useState<Rec[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const shown = useRef<string[]>([]);
  const { busy, added, err, add } = useAdder(playlistId, onAdded);

  const load = useCallback(async (more: boolean) => {
    setLoading(true); setError("");
    if (!more) shown.current = [];
    try {
      const r = await api<{ items: Rec[] }>(`/api/music/playlists/${playlistId}/recommendations`, { method: "POST", body: { shown: shown.current.slice(-150), n: 10 } });
      shown.current.push(...r.items.map((x) => x.key));
      setItems(r.items);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [playlistId]);
  // Loaded once; adding a song only removes it from the list (so the list doesn't jump). Refresh asks for new ones.
  const loaded = useRef(false);
  const usable = !!mode && (mode.local || mode.onDemand);
  useEffect(() => { if (usable && !loaded.current) { loaded.current = true; void load(false); } }, [usable, load]);

  if (!mode || (!mode.local && !mode.onDemand)) return null;
  const visible = (items ?? []).filter((r) => !added.has(r.key) && !inPlaylist.has(songKey(r.artist, r.title)));
  return (
    <section aria-label="Recommended songs" className="mt-10">
      <SectionTitle action={<button onClick={() => void load(true)} disabled={loading} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-50"><RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh</button>}>
        <span className="block">Recommended</span>
        <span className="block text-xs font-normal text-muted">{empty ? "Based on what you listen to" : "Based on what's in this playlist"}</span>
      </SectionTitle>
      {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
      {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
      {items === null && loading && <p className="flex items-center gap-2 py-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Finding songs…</p>}
      {visible.map((r, i) => {
        const row: RowItem = { key: r.key, input: r.input, title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec, cover: r.artworkUrl, trackId: r.trackId ?? undefined, note: r.reason };
        return <TrackRow key={r.key} item={row} onPlay={() => void playItems(visible.map((x) => x.input), { startIndex: i })} extra={<AddButton title={r.title} added={false} busy={busy === r.key} onAdd={() => void add(r.key, r.input)} />} />;
      })}
      {items !== null && !visible.length && !loading && <p className="py-3 text-sm text-muted">No more suggestions right now. Listen to a few more songs, or try Refresh later.</p>}
      {visible.length > 0 && visible.length < 4 && !loading && <button onClick={() => void load(true)} className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-white/70 hover:text-white"><Plus className="size-4" /> More suggestions</button>}
    </section>
  );
}
