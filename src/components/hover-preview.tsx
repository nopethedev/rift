"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Check, ChevronDown, Library, Play, Plus, X } from "lucide-react";
import { type CardItem, fmtDuration, tmdbImg } from "@/lib/types";
import { Badge } from "./ui";
import { useApp } from "./providers";
import { cardHref, playHref } from "@/lib/links";

interface Details {
  year: number | null; runtime: number | null; seasons: number | null; rating: number | null; certification: string | null;
  genres: string[]; overview: string; trailerKey: string | null; backdropPath: string | null; available: boolean; playFileId: string | null;
}

const cache = new Map<string, Details | null>();

function useDetails(item: CardItem) {
  const key = `${item.type}-${item.tmdbId}`;
  const [d, setD] = useState<Details | null | undefined>(cache.get(key));
  useEffect(() => {
    if (!item.tmdbId || cache.has(key)) return;
    let live = true;
    fetch(`/api/tmdb/details?type=${item.type}&id=${item.tmdbId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((v) => { cache.set(key, v); if (live) setD(v); });
    return () => { live = false; };
  }, [key, item.tmdbId, item.type]);
  return d;
}

/** Floating card (desktop, anchored on the poster) or bottom sheet (touch). The YouTube iframe only exists while mounted, so closing stops playback. */
export function HoverPreview({ item, rect, sheet, onClose }: { item: CardItem; rect: DOMRect; sheet: boolean; onClose: () => void }) {
  const { keepPreview, closePreview, inList, toggleList } = useApp();
  const d = useDetails(item);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    const close = () => !sheet && onClose();
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose, sheet]);

  const w = sheet ? Math.min(440, window.innerWidth - 24) : Math.min(Math.max(rect.width * 1.6, 320), 400);
  const left = sheet ? 0 : Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 12);
  const estH = w * 0.5625 + 190;
  const top = sheet ? 0 : Math.min(Math.max(12, rect.top + rect.height / 2 - estH / 2), Math.max(12, window.innerHeight - estH - 12));

  const play = playHref({ ...item, playFileId: item.playFileId ?? d?.playFileId ?? null, available: item.available || !!d?.available });
  const saved = inList(item);
  const backdrop = tmdbImg(item.backdropPath ?? d?.backdropPath, "w780") ?? tmdbImg(item.posterPath, "w500");

  const card = (
    <motion.div
      role="dialog"
      aria-label={`${item.title} preview`}
      initial={sheet ? { y: 60, opacity: 0 } : { opacity: 0, scale: 0.78 }}
      animate={sheet ? { y: 0, opacity: 1 } : { opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      style={sheet ? { width: w } : { position: "fixed", left, top, width: w, transformOrigin: "center" }}
      onPointerEnter={sheet ? undefined : keepPreview}
      onPointerLeave={sheet ? undefined : () => closePreview(120)}
      className="z-[60] overflow-hidden rounded-xl border border-white/10 bg-surface shadow-[0_24px_70px_-10px_rgba(0,0,0,0.9)]"
    >
      <div className="relative aspect-video bg-black">
        {backdrop && <img src={backdrop} alt="" className="absolute inset-0 size-full object-cover" />}
        {d?.trailerKey && (
          <iframe
            title={`${item.title} trailer`}
            className="absolute inset-0 size-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            src={`https://www.youtube-nocookie.com/embed/${d.trailerKey}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${d.trailerKey}&iv_load_policy=3&disablekb=1`}
          />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
        {sheet && <button onClick={onClose} aria-label="Close preview" className="absolute right-2 top-2 rounded-full bg-black/70 p-1.5"><X className="size-4" /></button>}
      </div>
      <div className="space-y-2.5 p-3.5">
        <div className="flex items-center gap-2">
          {play ? (
            <Link href={play} aria-label="Play" className="btn-primary flex size-9 items-center justify-center rounded-full"><Play className="size-4 fill-white" /></Link>
          ) : (
            <span title="Not in your library" className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white/40"><Play className="size-4" /></span>
          )}
          <button
            onClick={() => toggleList(item)}
            aria-label={saved ? "Remove from My List" : "Add to My List"}
            className="flex size-9 items-center justify-center rounded-full border border-white/30 transition hover:border-white hover:bg-white/10"
          >
            {saved ? <Check className="size-4" /> : <Plus className="size-4" />}
          </button>
          <Link href={cardHref(item)} aria-label="More info" className="ml-auto flex size-9 items-center justify-center rounded-full border border-white/30 transition hover:border-white hover:bg-white/10"><ChevronDown className="size-4" /></Link>
        </div>
        <p className="line-clamp-1 text-sm font-semibold">{item.title}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
          {d?.rating ? <span className="font-semibold text-emerald-400">{Math.round(d.rating * 10)}% match</span> : null}
          {d?.certification && <Badge>{d.certification}</Badge>}
          {(d?.year ?? item.year) && <span>{d?.year ?? item.year}</span>}
          {d?.runtime ? <span>{d.seasons ? `${d.seasons} season${d.seasons > 1 ? "s" : ""} · ` : ""}{fmtDuration(d.runtime * 60)}</span> : d?.seasons ? <span>{d.seasons} seasons</span> : null}
          {item.available || d?.available ? <Badge tone="accent"><Library className="size-3" /> In library</Badge> : <Badge>Discover only</Badge>}
        </div>
        {d?.genres?.length ? <p className="text-xs text-white/60">{d.genres.slice(0, 3).join(" • ")}</p> : d === undefined ? <div className="skeleton h-3 w-2/3" /> : null}
      </div>
    </motion.div>
  );

  if (!sheet) return card;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-3 pb-6 backdrop-blur-[2px]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>{card}</div>
    </div>
  );
}
