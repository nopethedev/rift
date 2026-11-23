"use client";
import { useState } from "react";
import clsx from "clsx";
import { AlertTriangle, ChevronDown, CloudDownload, ListMusic, Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Trash2, Volume2, VolumeX, X, Infinity as Auto, ArrowUp, ArrowDown } from "lucide-react";
import { fmtTime, type QueueItem } from "@/lib/music-types";
import { Cover } from "./parts";
import { useMusic } from "./player-provider";
import { ArtistCard, CurrentHeart, SidePanelToggle } from "./side-panel";

function Seek({ className }: { className?: string }) {
  const { position, duration, seek, capture, play } = useMusic();
  const [drag, setDrag] = useState<number | null>(null);
  const max = duration || 0;
  const shown = drag ?? position;
  const pct = max ? Math.min(100, (shown / max) * 100) : 0;
  // While an on-demand track is still being captured, show how much of it exists (the part you can seek to).
  const avail = play?.kind === "ondemand" && capture && capture.state !== "ready" ? Math.min(100, capture.progress * 100) : 100;
  return (
    <div className={clsx("flex items-center gap-2 text-[11px] tabular-nums text-muted", className)}>
      <span className="w-9 text-right">{fmtTime(shown)}</span>
      <input
        type="range" aria-label="Seek" className="rift-range min-w-0 flex-1" min={0} max={max || 1} step={1} value={Math.min(shown, max || 1)} disabled={!max}
        style={{ ["--track" as string]: `linear-gradient(90deg,#8b5cf6 ${pct}%,#ffffff55 ${pct}% ${Math.max(pct, avail)}%,#ffffff22 ${Math.max(pct, avail)}%)` }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag !== null) { seek(drag); setDrag(null); } }}
        onKeyUp={(e) => { if (drag !== null && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) { seek(drag); setDrag(null); } }}
      />
      <span className="w-9">{fmtTime(max)}</span>
    </div>
  );
}

function StatusLine({ className }: { className?: string }) {
  const { play, capture, error, loading } = useMusic();
  if (error) return <p role="alert" title={error} className={clsx("flex items-start gap-1.5 text-xs leading-snug text-amber-300", className)}><AlertTriangle className="mt-px size-3.5 shrink-0" /><span className="line-clamp-4 min-w-0 break-words">{error}</span></p>;
  if (loading) return <p className={clsx("flex items-center gap-1.5 text-xs text-muted", className)}><Loader2 className="size-3.5 animate-spin" /> Preparing…</p>;
  if (play?.kind === "ondemand" && capture && capture.state !== "ready") {
    const label = capture.state === "resolving" ? "Finding the right recording…" : capture.state === "queued" ? "Waiting for a download slot…" : `Fetching audio… ${Math.round(capture.progress * 100)}%`;
    return <p className={clsx("flex items-center gap-1.5 text-xs text-violet-300", className)}><CloudDownload className="size-3.5" />{label}</p>;
  }
  return null;
}

function Controls({ big }: { big?: boolean }) {
  const { playing, loading, toggle, next, prev, queue, setShuffle, setRepeat } = useMusic();
  const st = queue?.state;
  const sz = big ? "size-6" : "size-5";
  const RepeatIcon = st?.repeat === "one" ? Repeat1 : Repeat;
  return (
    <div className="flex items-center justify-center gap-1 sm:gap-2">
      <button aria-label="Shuffle" aria-pressed={!!st?.shuffle} onClick={() => setShuffle(!st?.shuffle)} className={clsx("hidden rounded-full p-2 sm:block", st?.shuffle ? "text-accent" : "text-white/60 hover:text-white")}><Shuffle className="size-4" /></button>
      <button aria-label="Previous" onClick={prev} className="rounded-full p-2 text-white/80 hover:text-white"><SkipBack className={clsx(sz, "fill-current")} /></button>
      <button aria-label={playing ? "Pause" : "Play"} onClick={toggle} className={clsx("flex items-center justify-center rounded-full bg-white text-black transition hover:scale-105", big ? "size-14" : "size-10")}>
        {loading ? <Loader2 className={clsx(sz, "animate-spin")} /> : playing ? <Pause className={clsx(sz, "fill-current")} /> : <Play className={clsx(sz, "ml-0.5 fill-current")} />}
      </button>
      <button aria-label="Next" onClick={next} className="rounded-full p-2 text-white/80 hover:text-white"><SkipForward className={clsx(sz, "fill-current")} /></button>
      <button aria-label={`Repeat ${st?.repeat ?? "off"}`} onClick={() => setRepeat(st?.repeat === "off" ? "all" : st?.repeat === "all" ? "one" : "off")} className={clsx("hidden rounded-full p-2 sm:block", st?.repeat !== "off" ? "text-accent" : "text-white/60 hover:text-white")}><RepeatIcon className="size-4" /></button>
    </div>
  );
}

export function PlayerBar() {
  const { current, queue, volume, setVolume, muted, setMuted } = useMusic();
  const [open, setOpen] = useState(false);
  if (!current) return null;
  return (
    <>
      <div className="glass fixed inset-x-0 bottom-[calc(3.8rem+env(safe-area-inset-bottom))] z-30 border-t border-white/10 md:bottom-0" data-testid="music-bar">
        <div className="mx-auto grid max-w-[1800px] grid-cols-[1fr_auto] items-center gap-2 py-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] md:pl-6 md:pr-6">
          <button onClick={() => setOpen(true)} className="flex min-w-0 items-center gap-3 text-left" aria-label="Open now playing">
            <Cover src={current.artworkUrl} className="size-11 md:size-12" />
            <span className="min-w-0"><span className="block truncate text-sm font-semibold">{current.title}</span><span className="block truncate text-xs text-muted">{current.artist}</span><StatusLine className="md:hidden" /></span>
          </button>
          <div className="hidden min-w-0 flex-col gap-0.5 md:flex"><Controls /><Seek /></div>
          <div className="hidden items-center justify-end gap-2 md:flex">
            <StatusLine className="max-w-72" />
            <CurrentHeart />
            <button aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)} className="text-white/70 hover:text-white">{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</button>
            <input type="range" aria-label="Volume" className="rift-range w-24" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={(e) => { setMuted(false); setVolume(Number(e.target.value)); }} style={{ ["--track" as string]: `linear-gradient(90deg,#fff ${(muted ? 0 : volume) * 100}%,#ffffff33 ${(muted ? 0 : volume) * 100}%)` }} />
            <SidePanelToggle />
            <button aria-label="Queue" onClick={() => setOpen(true)} className="relative rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white"><ListMusic className="size-5" />{!!queue?.items.length && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-accent px-1 text-[9px] font-bold">{queue.items.length}</span>}</button>
          </div>
          <div className="md:hidden"><MiniControls /></div>
        </div>
        <MiniProgress />
      </div>
      {open && <NowPlaying onClose={() => setOpen(false)} />}
    </>
  );
}

function MiniControls() {
  const { playing, toggle, next, loading } = useMusic();
  return (
    <div className="flex items-center gap-1">
      <button aria-label={playing ? "Pause" : "Play"} onClick={toggle} className="flex size-10 items-center justify-center rounded-full bg-white text-black">{loading ? <Loader2 className="size-5 animate-spin" /> : playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}</button>
      <button aria-label="Next" onClick={next} className="p-2 text-white/80"><SkipForward className="size-5 fill-current" /></button>
    </div>
  );
}

function MiniProgress() {
  const { position, duration } = useMusic();
  return <div className="h-0.5 bg-white/10 md:hidden"><div className="h-full bg-accent" style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }} /></div>;
}

function QueueRow({ it, idx, last, active }: { it: QueueItem; idx: number; last: boolean; active: boolean }) {
  const { playQueueItem, removeFromQueue, moveInQueue } = useMusic();
  return (
    <li className={clsx("flex items-center gap-2 rounded-lg px-2 py-1.5", active ? "bg-accent/20" : "hover:bg-white/5")}>
      <button onClick={() => playQueueItem(it.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Play ${it.title}`}>
        <Cover src={it.artworkUrl} className="size-10" />
        <span className="min-w-0"><span className={clsx("block truncate text-sm", active && "font-semibold text-violet-200")}>{it.title}</span><span className="block truncate text-xs text-muted">{it.artist}{it.local ? "" : " · on-demand"}{it.origin === "autoplay" ? " · autoplay" : ""}</span></span>
      </button>
      <span className="text-xs tabular-nums text-muted">{fmtTime(it.durationSec)}</span>
      <button aria-label="Move up" disabled={idx === 0} onClick={() => moveInQueue(it.id, idx - 1)} className="p-1 text-white/50 hover:text-white disabled:opacity-20"><ArrowUp className="size-4" /></button>
      <button aria-label="Move down" disabled={last} onClick={() => moveInQueue(it.id, idx + 1)} className="p-1 text-white/50 hover:text-white disabled:opacity-20"><ArrowDown className="size-4" /></button>
      <button aria-label={`Remove ${it.title}`} onClick={() => removeFromQueue(it.id)} className="p-1 text-white/50 hover:text-red-300"><X className="size-4" /></button>
    </li>
  );
}

export function NowPlaying({ onClose }: { onClose: () => void }) {
  const { current, queue, setAutoplay, clearQueue, play } = useMusic();
  if (!current) return null;
  const items = queue?.items ?? [];
  const idx = items.findIndex((i) => i.id === current.id);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/97 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="Now playing">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={onClose} aria-label="Close" className="rounded-full p-2 hover:bg-white/10"><ChevronDown className="size-6" /></button>
        <p className="text-sm font-semibold text-white/80">Now playing</p>
        <span className="size-10" />
      </div>
      <div className="mx-auto grid min-h-0 w-full max-w-5xl flex-1 gap-6 overflow-y-auto px-4 pb-6 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] md:gap-10">
        <div className="flex flex-col items-center gap-4">
          <Cover src={current.artworkUrl} className="aspect-square w-full max-w-72 md:max-w-none" rounded="rounded-2xl" />
          <div className="w-full text-center"><p className="flex items-center justify-center gap-1 text-xl font-bold"><span className="truncate">{current.title}</span><CurrentHeart /></p><p className="truncate text-sm text-muted">{current.artist}{current.album ? ` · ${current.album}` : ""}</p>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{play?.kind === "ondemand" ? "Streaming on demand" : play?.transcode ? "Library · converted for your browser" : "Library"}</p></div>
          <Seek className="w-full" />
          <Controls big />
          <StatusLine />
          <div className="flex flex-wrap justify-center gap-2 text-xs">
            <button aria-pressed={!!queue?.state.autoplay} onClick={() => setAutoplay(!queue?.state.autoplay)} className={clsx("flex items-center gap-1.5 rounded-full px-3 py-1.5", queue?.state.autoplay ? "bg-accent/30 text-white" : "bg-white/10 text-muted")}><Auto className="size-3.5" /> Autoplay {queue?.state.autoplay ? "on" : "off"}</button>
            <div className="flex gap-2 sm:hidden"><MobileToggles /></div>
          </div>
          <ArtistCard artist={current.artist} className="w-full text-left" />
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between"><h3 className="font-bold">Queue <span className="text-sm font-normal text-muted">· {items.length}</span></h3><button onClick={() => clearQueue().then(onClose)} className="flex items-center gap-1 text-xs text-muted hover:text-red-300"><Trash2 className="size-3.5" /> Clear</button></div>
          <ul className="space-y-0.5">{items.map((it, i) => <QueueRow key={it.id} it={it} idx={i} last={i === items.length - 1} active={i === idx} />)}</ul>
        </div>
      </div>
    </div>
  );
}

function MobileToggles() {
  const { queue, setShuffle, setRepeat } = useMusic();
  const st = queue?.state;
  const RepeatIcon = st?.repeat === "one" ? Repeat1 : Repeat;
  return (
    <>
      <button aria-label="Shuffle" aria-pressed={!!st?.shuffle} onClick={() => setShuffle(!st?.shuffle)} className={clsx("flex items-center gap-1.5 rounded-full px-3 py-1.5", st?.shuffle ? "bg-accent/30 text-white" : "bg-white/10 text-muted")}><Shuffle className="size-3.5" /> Shuffle</button>
      <button aria-label="Repeat" onClick={() => setRepeat(st?.repeat === "off" ? "all" : st?.repeat === "all" ? "one" : "off")} className={clsx("flex items-center gap-1.5 rounded-full px-3 py-1.5", st?.repeat !== "off" ? "bg-accent/30 text-white" : "bg-white/10 text-muted")}><RepeatIcon className="size-3.5" /> {st?.repeat ?? "off"}</button>
    </>
  );
}

export function MusicSpacer() {
  const { current } = useMusic();
  return current ? <div className="h-20 md:h-16" aria-hidden /> : null;
}
