"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertCircle, CloudDownload, HardDrive, ListEnd, ListPlus, ListStart, MoreHorizontal, Music2, Pause, Play, Radio as RadioIcon, Plus } from "lucide-react";
import { api, Button, Input } from "../ui";
import { Modal } from "@/app/admin/parts";
import { fmtTime, type AlbumDTO, type ArtistDTO, type Candidate, type ItemInput, type TrackDTO } from "@/lib/music-types";
import { useMusic } from "./player-provider";

export function Cover({ src, className, rounded = "rounded-lg" }: { src?: string | null; className?: string; rounded?: string }) {
  return (
    <div className={clsx("relative shrink-0 overflow-hidden bg-gradient-to-br from-accent/40 via-surface-2 to-surface", rounded, className)}>
      {src ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <Music2 className="absolute inset-0 m-auto size-1/3 text-white/40" />}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="mb-3 mt-8 flex items-end justify-between first:mt-0"><h2 className="text-lg font-bold sm:text-xl">{children}</h2>{action}</div>;
}

export function Empty({ icon: Icon = Music2, title, children }: { icon?: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      <Icon className="size-9 text-white/30" />
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

/** Where the audio comes from, so on-demand and library tracks are distinguishable at a glance. */
export function SourceBadge({ kind }: { kind: "local" | "ondemand" }) {
  return kind === "local"
    ? <span title="Plays from your library" className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"><HardDrive className="size-3" /> Library</span>
    : <span title="Streamed on demand from an authorised source" className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-300"><CloudDownload className="size-3" /> On-demand</span>;
}

export interface RowItem { key: string; input: ItemInput; title: string; artist: string; album?: string | null; durationSec?: number | null; cover?: string | null; trackId?: string; note?: string; unavailable?: string }

/** One list row. Click plays the whole list from here (`onPlay`); the menu adds to the queue or a playlist. */
export function TrackRow({ item, index, onPlay, active, extra }: { item: RowItem; index?: number; onPlay: () => void; active?: boolean; extra?: React.ReactNode }) {
  const { playing, toggle } = useMusic();
  const disabled = !!item.unavailable;
  return (
    <div data-focusable tabIndex={disabled ? -1 : 0} onKeyDown={(e) => { if (e.key === "Enter" && !disabled) onPlay(); }} className={clsx("group flex items-center gap-3 rounded-xl px-2 py-1.5 outline-none transition", active ? "bg-accent/15" : "hover:bg-white/5", disabled && "opacity-50")}>
      <button disabled={disabled} onClick={() => (active ? toggle() : onPlay())} aria-label={active && playing ? `Pause ${item.title}` : `Play ${item.title}`} className="relative size-11 shrink-0">
        <Cover src={item.cover} className="size-11" />
        <span className={clsx("absolute inset-0 flex items-center justify-center rounded-lg bg-black/55 transition", active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}>
          {active && playing ? <Pause className="size-5 fill-white" /> : <Play className="size-5 fill-white" />}
        </span>
      </button>
      {index !== undefined && <span className="hidden w-6 text-right text-xs tabular-nums text-muted sm:block">{index + 1}</span>}
      <div className="min-w-0 flex-1">
        <p className={clsx("truncate text-sm font-medium", active && "text-violet-200")}>{item.title}</p>
        <p className="truncate text-xs text-muted">
          {item.artist}{item.album ? ` · ${item.album}` : ""}
          {item.unavailable && <span className="ml-2 inline-flex items-center gap-1 text-amber-300"><AlertCircle className="size-3" />{item.unavailable}</span>}
        </p>
      </div>
      {item.note && <span className="hidden sm:block"><span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">{item.note}</span></span>}
      {extra}
      <span className="w-11 text-right text-xs tabular-nums text-muted">{fmtTime(item.durationSec)}</span>
      {!disabled && <TrackMenu item={item} />}
    </div>
  );
}

export function TrackMenu({ item }: { item: Pick<RowItem, "input" | "trackId" | "title"> }) {
  const { addToQueue, playRadio, mode } = useMusic();
  const [open, setOpen] = useState(false);
  const [pl, setPl] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", f); return () => document.removeEventListener("mousedown", f); }, [open]);
  const act = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div ref={ref} className="relative">
      <button aria-label={`Options for ${item.title}`} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"><MoreHorizontal className="size-4" /></button>
      {open && (
        <div className="glass absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-xl border border-white/10 py-1 text-sm shadow-2xl">
          <button onClick={act(() => void addToQueue([item.input], "next"))} className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-white/10"><ListStart className="size-4" /> Play next</button>
          <button onClick={act(() => void addToQueue([item.input], "end"))} className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-white/10"><ListEnd className="size-4" /> Add to queue</button>
          <button onClick={act(() => setPl(true))} className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-white/10"><ListPlus className="size-4" /> Add to playlist…</button>
          {item.trackId && mode?.local && <button onClick={act(() => void playRadio(item.trackId!))} className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-white/10"><RadioIcon className="size-4" /> Start radio</button>}
        </div>
      )}
      {pl && <AddToPlaylist inputs={[item.input]} onClose={() => setPl(false)} />}
    </div>
  );
}

export function AddToPlaylist({ inputs, onClose }: { inputs: ItemInput[]; onClose: () => void }) {
  const [lists, setLists] = useState<{ id: string; name: string; count: number }[] | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ playlists: { id: string; name: string; count: number }[] }>("/api/music/playlists").then((r) => setLists(r.playlists)).catch((e) => setMsg(e.message)); }, []);
  async function add(id: string) {
    setBusy(true);
    try { await api(`/api/music/playlists/${id}/items`, { method: "POST", body: { items: inputs } }); onClose(); } catch (e) { setMsg((e as Error).message); setBusy(false); }
  }
  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try { const r = await api<{ id: string }>("/api/music/playlists", { method: "POST", body: { name } }); await add(r.id); } catch (e) { setMsg((e as Error).message); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Add to playlist">
      <div className="space-y-3">
        <div className="flex gap-2"><Input aria-label="New playlist name" placeholder="New playlist" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} /><Button onClick={create} disabled={!name.trim() || busy}><Plus className="size-4" /> Create</Button></div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {lists?.map((l) => <li key={l.id}><button disabled={busy} onClick={() => add(l.id)} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10"><span className="truncate">{l.name}</span><span className="text-xs text-muted">{l.count}</span></button></li>)}
          {lists && !lists.length && <li className="px-3 py-2 text-sm text-muted">No playlists yet.</li>}
        </ul>
        {msg && <p role="alert" className="text-sm text-red-300">{msg}</p>}
      </div>
    </Modal>
  );
}

export function AlbumCard({ a }: { a: AlbumDTO }) {
  return (
    <Link href={`/music/albums/${a.albumKey}`} data-card data-focusable className="group block w-full min-w-0">
      <Cover src={a.coverUrl} className="aspect-square w-full transition group-hover:brightness-110" rounded="rounded-xl" />
      <p className="mt-2 truncate text-sm font-semibold">{a.album}</p>
      <p className="truncate text-xs text-muted">{a.artist}{a.year ? ` · ${a.year}` : ""}</p>
    </Link>
  );
}
export function ArtistCard({ a }: { a: ArtistDTO }) {
  return (
    <Link href={`/music/artists/${encodeURIComponent(a.artist)}`} data-card data-focusable className="group block w-full min-w-0 text-center">
      <Cover src={a.coverUrl} className="mx-auto aspect-square w-full transition group-hover:brightness-110" rounded="rounded-full" />
      <p className="mt-2 truncate text-sm font-semibold">{a.artist}</p>
      <p className="text-xs text-muted">{a.tracks} track{a.tracks === 1 ? "" : "s"}</p>
    </Link>
  );
}

export const trackRow = (t: TrackDTO, o: Partial<RowItem> = {}): RowItem => ({ key: t.id, input: { trackId: t.id }, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.coverUrl, trackId: t.id, ...o });
export const candidateRow = (c: Candidate): RowItem => ({
  key: c.sourceId, title: c.title, artist: c.artist || c.sourceName || "", durationSec: c.durationSec, cover: c.artworkUrl ?? null, note: c.sourceName ?? "on-demand",
  input: { title: c.title, artist: c.artist, durationSec: c.durationSec, artworkUrl: c.artworkUrl ?? null, candidate: c },
});

export const Grid = ({ children }: { children: React.ReactNode }) => <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{children}</div>;
