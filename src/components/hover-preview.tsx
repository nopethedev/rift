"use client";
import Link from "next/link";
import { motion } from "motion/react";
import { Check, ChevronDown, Library, Play, Plus, X, Zap } from "lucide-react";
import { type CardItem, fmtDuration, tmdbImg } from "@/lib/types";
import { Badge } from "./ui";
import { useApp } from "./providers";
import { trailerSrc, useDetails } from "./use-details";
import { cardHref, playHref } from "@/lib/links";

/**
 * Bottom sheet with trailer + actions for touch devices (a first tap on a poster opens it).
 * Mouse and keyboard users get the in-place 16:9 expansion of the poster itself (see poster-card.tsx).
 */
export function PreviewSheet({ item, onClose }: { item: CardItem; onClose: () => void }) {
  const { inList, toggleList, onDemand, playOnDemand } = useApp();
  const d = useDetails(item);
  const w = Math.min(440, window.innerWidth - 24);
  const play = playHref({ ...item, playFileId: item.playFileId ?? d?.playFileId ?? null, available: item.available || !!d?.available });
  const saved = inList(item);
  const backdrop = tmdbImg(item.backdropPath ?? d?.backdropPath, "w780") ?? tmdbImg(item.posterPath, "w500");

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-3 pb-6 backdrop-blur-[2px]" onClick={onClose}>
      <motion.div
        role="dialog" aria-modal="true" aria-label={`${item.title} preview`}
        initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}
        style={{ width: w }} onClick={(e) => e.stopPropagation()}
        className="overflow-hidden rounded-xl border border-white/10 bg-surface shadow-[0_24px_70px_-10px_rgba(0,0,0,0.9)]"
      >
        <div className="relative aspect-video bg-black">
          {backdrop && <img src={backdrop} alt="" className="absolute inset-0 size-full object-cover" />}
          {d?.trailerKey && <iframe title={`${item.title} trailer`} className="absolute inset-0 size-full" allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" src={trailerSrc(d.trailerKey)} />}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />
          <button onClick={onClose} aria-label="Close preview" className="absolute right-2 top-2 rounded-full bg-black/70 p-1.5"><X className="size-4" /></button>
        </div>
        <div className="space-y-2.5 p-3.5">
          <div className="flex items-center gap-2">
            {play ? (
              <Link href={play} aria-label="Play" className="btn-primary flex size-9 items-center justify-center rounded-full"><Play className="size-4 fill-white" /></Link>
            ) : onDemand && item.tmdbId ? (
              <button onClick={() => playOnDemand(item)} aria-label="Play (streams on demand)" className="btn-primary flex size-9 items-center justify-center rounded-full"><Play className="size-4 fill-white" /></button>
            ) : (
              <span title="Not in your library" className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white/40"><Play className="size-4" /></span>
            )}
            <button onClick={() => toggleList(item)} aria-label={saved ? "Remove from My List" : "Add to My List"} className="flex size-9 items-center justify-center rounded-full border border-white/30 transition hover:border-white hover:bg-white/10">
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
            {item.available || d?.available ? <Badge tone="accent"><Library className="size-3" /> In library</Badge> : onDemand ? <Badge><Zap className="size-3" /> Stream on demand</Badge> : <Badge>Discover only</Badge>}
          </div>
          {d?.genres?.length ? <p className="text-xs text-white/60">{d.genres.slice(0, 3).join(" • ")}</p> : d === undefined ? <div className="skeleton h-3 w-2/3" /> : null}
        </div>
      </motion.div>
    </div>
  );
}
