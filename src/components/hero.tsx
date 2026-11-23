"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check, Info, Library, Play, Plus } from "lucide-react";
import { type CardItem, tmdbImg } from "@/lib/types";
import { cardHref, playHref } from "@/lib/links";
import { Badge } from "./ui";
import { useApp } from "./providers";

/** Cinematic hero banner rotating through featured titles. */
export function Hero({ items }: { items: CardItem[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const { inList, toggleList } = useApp();
  useEffect(() => {
    if (paused || items.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), 9000);
    return () => clearInterval(t);
  }, [paused, items.length]);
  const it = items[i];
  if (!it) return null;
  const play = playHref(it);
  const saved = inList(it);
  const bg = tmdbImg(it.backdropPath, "original");

  return (
    <header className="relative h-[68vh] min-h-[32rem] w-full overflow-hidden sm:h-[80vh] sm:min-h-[40rem]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <AnimatePresence mode="sync">
        <motion.div key={it.key} initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9 }} className="absolute inset-0">
          {bg && <img src={bg} alt="" className="size-full object-cover object-top" />}
        </motion.div>
      </AnimatePresence>
      <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/50 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-bg to-transparent" />
      {/* The rows below are pulled up over the bottom of the hero (-mt-16 / sm:-mt-24), so keep the text clear of that
          strip (plus the fixed navbar on top) and let it centre in what's left instead of running under the rows. */}
      <div className="absolute inset-0 flex items-end overflow-hidden pb-20 pt-16 sm:items-center sm:pb-28 sm:pt-20">
        <AnimatePresence mode="wait">
          <motion.div key={it.key} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.45 }} className="w-full max-w-2xl space-y-3 px-4 sm:space-y-4 sm:px-12">
            <div className="flex flex-wrap items-center gap-2">
              {it.available ? <Badge tone="accent"><Library className="size-3" /> In your library</Badge> : <Badge>Discover</Badge>}
              <Badge>{it.type === "tv" ? "Series" : "Movie"}</Badge>
              {it.rating ? <span className="text-sm font-semibold text-emerald-400">{Math.round(it.rating * 10)}% match</span> : null}
              {it.year ? <span className="text-sm text-white/70">{it.year}</span> : null}
            </div>
            <h1 className="line-clamp-3 text-balance break-words text-3xl font-extrabold leading-tight tracking-tight drop-shadow-lg sm:text-5xl lg:text-6xl">{it.title}</h1>
            {it.overview && <p className="line-clamp-3 max-w-xl text-sm text-white/85 drop-shadow sm:text-base">{it.overview}</p>}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {play && (
                <Link href={play} data-autofocus className="btn-primary inline-flex items-center gap-2 rounded-lg px-6 py-3 font-semibold"><Play className="size-5 fill-white" /> Play</Link>
              )}
              <Link href={cardHref(it)} data-autofocus={play ? undefined : true} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/15 px-5 py-3 font-semibold backdrop-blur transition hover:bg-white/25"><Info className="size-5" /> More info</Link>
              <button onClick={() => toggleList(it)} aria-label={saved ? "Remove from My List" : "Add to My List"} className="flex size-12 items-center justify-center rounded-full border border-white/30 bg-black/30 backdrop-blur transition hover:border-white hover:bg-white/10">
                {saved ? <Check className="size-5" /> : <Plus className="size-5" />}
              </button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      {items.length > 1 && (
        <div className="absolute right-4 top-[4.5rem] flex gap-1.5 sm:bottom-16 sm:right-12 sm:top-auto">
          {items.map((x, n) => (
            <button key={x.key} tabIndex={-1} aria-label={`Show ${x.title}`} onClick={() => setI(n)} className="group/dot py-3"><span className={`block h-1 rounded-full transition-all ${n === i ? "w-8 bg-accent" : "w-4 bg-white/30 group-hover/dot:bg-white/60"}`} /></button>
          ))}
        </div>
      )}
    </header>
  );
}
