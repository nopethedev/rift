"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check, Clapperboard, Play, Plus, X, Zap } from "lucide-react";
import type { CardItem } from "@/lib/types";
import { useApp } from "@/components/providers";

/** A not-in-library episode row: starts an on-demand stream when the server allows it for this account. */
export function OnDemandEpisode({ tmdbId, season, episode, children }: { tmdbId: number; season: number; episode: number; children: React.ReactNode }) {
  const { onDemand, playOnDemand } = useApp();
  if (!onDemand) return <div className="flex items-center gap-3 p-3 opacity-55">{children}</div>;
  return (
    <div
      role="button" tabIndex={0} data-focusable aria-label={`Play episode ${episode}`}
      onClick={() => playOnDemand({ type: "tv", tmdbId }, season, episode)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playOnDemand({ type: "tv", tmdbId }, season, episode); } }}
      className="group flex cursor-pointer items-center gap-3 p-3 transition hover:bg-white/5"
    >
      {children}
    </div>
  );
}

export function TitleActions({ card, playHref, playLabel, trailerKey, stream }: { card: CardItem; playHref: string | null; playLabel: string; trailerKey: string | null; resumeFraction: number | null; stream?: { season: number; episode: number } }) {
  const { inList, toggleList, onDemand, playOnDemand } = useApp();
  const [trailer, setTrailer] = useState(false);
  const saved = inList(card);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {playHref && (
          <Link href={playHref} className="btn-primary inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-semibold"><Play className="size-5 fill-white" /> {playLabel}</Link>
        )}
        {!playHref && onDemand && card.tmdbId && (
          <button onClick={() => playOnDemand(card, stream?.season, stream?.episode)} data-autofocus className="btn-primary inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-semibold">
            <Play className="size-5 fill-white" /> {card.type === "tv" && stream ? `Play S${stream.season}:E${stream.episode}` : "Play"}
            <span title="Streams on demand" className="ml-1 rounded bg-black/25 p-0.5"><Zap className="size-3.5" /></span>
          </button>
        )}
        {trailerKey && (
          <button onClick={() => setTrailer(true)} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/15 px-5 py-3 font-semibold backdrop-blur transition hover:bg-white/25"><Clapperboard className="size-5" /> Trailer</button>
        )}
        <button onClick={() => toggleList(card)} className="inline-flex items-center gap-2 rounded-lg border border-white/25 px-5 py-3 font-semibold transition hover:bg-white/10">
          {saved ? <Check className="size-5" /> : <Plus className="size-5" />} My List
        </button>
      </div>
      <AnimatePresence>
        {trailer && trailerKey && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-4" onClick={() => setTrailer(false)}>
            <div className="relative aspect-video w-full max-w-4xl overflow-hidden rounded-xl bg-black shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <iframe
                title="Trailer"
                className="size-full"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&rel=0&modestbranding=1`}
              />
              <button onClick={() => setTrailer(false)} aria-label="Close trailer" className="absolute right-3 top-3 rounded-full bg-black/70 p-2 hover:bg-black"><X className="size-5" /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
