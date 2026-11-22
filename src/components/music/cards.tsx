"use client";
import { useRef } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { catInput, type CatAlbum, type CatArtist, type CatTrack, type TrackDTO } from "@/lib/music-types";
import { Cover } from "./parts";
import { useMusic } from "./player-provider";

/** Spotify-style horizontal shelf: title row (optionally a "Show all" link) over a snapping, scrollable row of cards. */
export function ShelfRow({ title, subtitle, href, children }: { title: string; subtitle?: string; href?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="group/shelf mt-8 first:mt-0">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold hover:underline">{href ? <Link href={href}>{title}</Link> : title}</h2>
          {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <button aria-label="Scroll left" onClick={() => by(-1)} className="rounded-full bg-black/30 p-1.5 text-white/70 opacity-0 transition hover:text-white group-hover/shelf:opacity-100 focus-visible:opacity-100"><ChevronLeft className="size-5" /></button>
          <button aria-label="Scroll right" onClick={() => by(1)} className="rounded-full bg-black/30 p-1.5 text-white/70 opacity-0 transition hover:text-white group-hover/shelf:opacity-100 focus-visible:opacity-100"><ChevronRight className="size-5" /></button>
        </div>
      </div>
      <div ref={ref} className="no-scrollbar -mx-2 flex snap-x gap-4 overflow-x-auto px-2 pb-2 [scroll-padding:0_0.5rem]">{children}</div>
    </section>
  );
}

const CARD = "group relative w-36 shrink-0 snap-start rounded-xl p-2 transition hover:bg-white/10 focus-within:bg-white/10 sm:w-44";

function PlayFab({ onClick, label, active, playing }: { onClick: () => void; label: string; active?: boolean; playing?: boolean }) {
  return (
    <button aria-label={label} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }} className={clsx("absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-accent text-white shadow-xl transition", active ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100")}>
      {active && playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
    </button>
  );
}

/** A song from the online catalogue; clicking plays it (and the rest of the shelf continues after it). */
export function CatTrackCard({ t, all, index }: { t: CatTrack; all: CatTrack[]; index: number }) {
  const { playItems, current, play, playing, toggle } = useMusic();
  const active = !!current && !!play && current.title === t.title && current.artist === t.artist;
  const go = () => (active ? toggle() : void playItems(all.map(catInput), { startIndex: index, shuffle: false }));
  return (
    <div className={CARD} data-card>
      <div className="relative"><Cover src={t.artworkUrl} className="aspect-square w-full" rounded="rounded-lg" /><PlayFab onClick={go} label={`Play ${t.title}`} active={active} playing={playing} /></div>
      <button data-focusable onClick={go} className="mt-2 block w-full text-left outline-none"><p className={clsx("truncate text-sm font-semibold", active && "text-violet-300")}>{t.title}</p></button>
      {t.artistId ? <Link href={`/music/artists/${encodeURIComponent(t.artist)}?id=${t.artistId}`} className="block truncate text-xs text-muted hover:text-white hover:underline">{t.artist}</Link> : <p className="truncate text-xs text-muted">{t.artist}</p>}
    </div>
  );
}

export function CatAlbumCard({ a }: { a: CatAlbum }) {
  return (
    <Link href={`/music/release/${a.id}`} data-card data-focusable className={CARD}>
      <Cover src={a.artworkUrl} className="aspect-square w-full" rounded="rounded-lg" />
      <p className="mt-2 truncate text-sm font-semibold">{a.title}</p>
      <p className="truncate text-xs text-muted">{[a.year, a.kind && a.kind !== "album" ? a.kind.toUpperCase() : null, a.artist].filter(Boolean).join(" · ")}</p>
    </Link>
  );
}

export function CatArtistCard({ a }: { a: CatArtist }) {
  return (
    <Link href={`/music/artists/${encodeURIComponent(a.name)}?id=${a.id}`} data-card data-focusable className={clsx(CARD, "text-center")}>
      <Cover src={a.pictureUrl} className="mx-auto aspect-square w-full" rounded="rounded-full" />
      <p className="mt-2 truncate text-sm font-semibold">{a.name}</p>
      <p className="text-xs text-muted">Artist</p>
    </Link>
  );
}

/** A library song as a shelf card. */
export function LocalTrackCard({ t, all, index }: { t: TrackDTO; all: TrackDTO[]; index: number }) {
  const { playItems, current, play, playing, toggle } = useMusic();
  const active = current?.trackId === t.id && play?.kind === "local";
  const go = () => (active ? toggle() : void playItems(all.map((x) => ({ trackId: x.id })), { startIndex: index, shuffle: false }));
  return (
    <div className={CARD} data-card>
      <div className="relative"><Cover src={t.coverUrl} className="aspect-square w-full" rounded="rounded-lg" /><PlayFab onClick={go} label={`Play ${t.title}`} active={active} playing={playing} /></div>
      <button data-focusable onClick={go} className="mt-2 block w-full text-left outline-none"><p className={clsx("truncate text-sm font-semibold", active && "text-violet-300")}>{t.title}</p></button>
      <Link href={`/music/artists/${encodeURIComponent(t.artist)}`} className="block truncate text-xs text-muted hover:text-white hover:underline">{t.artist}</Link>
    </div>
  );
}
