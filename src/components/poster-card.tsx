"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Check, ChevronDown, Library, Play, Plus, Zap } from "lucide-react";
import { type CardItem, fmtDuration, tmdbImg } from "@/lib/types";
import { cardHref, playHref } from "@/lib/links";
import { useApp } from "./providers";
import { Badge, ProgressBar } from "./ui";
import { trailerSrc, useDetails } from "./use-details";

const HOVER_DELAY_MS = 700;
/** 16:9 over the poster's 2:3 at the same height. */
const WIDE = (16 / 9) * (3 / 2);

/**
 * Poster that, after hovering (or keyboard focus) for a moment, expands IN PLACE to 16:9 and plays the trailer muted,
 * with Play / My List / More info underneath. Touch devices open a bottom sheet instead (see hover-preview.tsx).
 *
 * `inline` (carousels): the card itself widens and pushes its neighbours aside.
 * default (grids): the card grows over its neighbours from its own spot, towards the side with more room.
 */
export function PosterCard({ item, className, inline = false }: { item: CardItem; className?: string; inline?: boolean }) {
  const { openSheet, inList, toggleList, onDemand, playOnDemand } = useApp();
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [side, setSide] = useState<"left" | "right">("left");
  const [broken, setBroken] = useState(false);
  const d = useDetails(item, expanded);

  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);

  const schedule = () => {
    clear();
    timer.current = setTimeout(() => {
      const r = root.current?.getBoundingClientRect();
      if (r) setSide(r.left + r.width / 2 > window.innerWidth * 0.55 ? "right" : "left");
      setExpanded(true);
    }, HOVER_DELAY_MS);
  };
  const collapse = () => { clear(); setExpanded(false); };

  // Keep the grown card fully on screen once the width transition is done.
  useEffect(() => {
    if (!expanded || !inline) return;
    const t = setTimeout(() => root.current?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" }), 330);
    return () => clearTimeout(t);
  }, [expanded, inline]);

  // Esc collapses; scrolling the page away does too.
  useEffect(() => {
    if (!expanded) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && collapse();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [expanded]);

  const poster = broken ? null : tmdbImg(item.posterPath, "w342");
  const backdrop = tmdbImg(item.backdropPath ?? d?.backdropPath, "w780") ?? tmdbImg(item.posterPath, "w500");
  const play = playHref({ ...item, playFileId: item.playFileId ?? d?.playFileId ?? null, available: item.available || !!d?.available });
  const saved = inList(item);

  const cardBox: React.CSSProperties = inline
    ? { width: expanded ? `calc(var(--cw) * ${WIDE})` : "var(--cw)", height: "calc(var(--cw) * 1.5)" }
    : { aspectRatio: "2 / 3" };
  const body = (
    <div
      className={clsx(
        "absolute top-0 h-full",
        inline ? "inset-0" : "transition-[width] duration-300 ease-out",
        !inline && (side === "right" ? "right-0" : "left-0"),
        !inline && expanded && "z-30",
      )}
      style={inline ? undefined : { width: expanded ? `${WIDE * 100}%` : "100%" }}
    >
      <div className={clsx("relative size-full rounded-lg bg-surface transition-shadow duration-300", expanded && "shadow-[0_24px_60px_-12px_rgba(0,0,0,0.95)] ring-1 ring-white/15")}>
        <Link
          href={cardHref(item)}
          data-card
          aria-label={item.title}
          className="absolute inset-0 block overflow-hidden rounded-lg outline-none"
          onClick={(e) => {
            // Touch devices: first tap opens the bottom sheet instead of navigating.
            if (window.matchMedia("(hover: none)").matches && item.tmdbId) { e.preventDefault(); openSheet(item); }
          }}
        >
          {poster ? (
            <img src={poster} alt={item.title} loading="lazy" draggable={false} onError={() => setBroken(true)} className={clsx("absolute inset-0 size-full object-cover transition-opacity duration-300", !item.available && "saturate-[.8]", expanded && backdrop && "opacity-0")} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-2 p-3 text-center text-sm text-muted">{item.title}</div>
          )}
          {backdrop && <img src={backdrop} alt="" draggable={false} className={clsx("absolute inset-0 size-full object-cover transition-opacity duration-300", expanded ? "opacity-100" : "opacity-0")} />}
          {expanded && d?.trailerKey && (
            <iframe
              title={`${item.title} trailer`}
              tabIndex={-1}
              className="pointer-events-none absolute inset-0 size-full scale-[1.02]"
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              src={trailerSrc(d.trailerKey)}
            />
          )}
          {!expanded && (item.progress || item.subtitle) && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 pt-8">
              {item.subtitle && <p className="mb-1 truncate text-[11px] text-white/80">{item.subtitle}</p>}
              {item.progress && item.progress.duration > 0 && <ProgressBar value={item.progress.position / item.progress.duration} />}
            </div>
          )}
          {expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black via-black/70 to-transparent" />}
        </Link>

        <div className="pointer-events-none absolute left-1.5 top-1.5">
          {item.available ? (
            <span className="flex items-center gap-1 rounded-md bg-accent/90 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow"><Library className="size-3" /> In library</span>
          ) : !expanded ? (
            <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70 backdrop-blur">Discover</span>
          ) : null}
        </div>

        {expanded && (
          <div data-card-actions className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1.5 p-3">
            <div className="pointer-events-auto flex items-center gap-2">
              {play ? (
                <Link href={play} aria-label="Play" className="btn-primary flex size-9 items-center justify-center rounded-full"><Play className="size-4 fill-white" /></Link>
              ) : onDemand && item.tmdbId ? (
                <button type="button" onClick={() => playOnDemand(item)} aria-label="Play (streams on demand)" title="Play: streams on demand" className="btn-primary flex size-9 items-center justify-center rounded-full"><Play className="size-4 fill-white" /></button>
              ) : (
                <span title="Not in your library" className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white/40"><Play className="size-4" /></span>
              )}
              <button type="button" onClick={() => toggleList(item)} aria-label={saved ? "Remove from My List" : "Add to My List"} className="flex size-9 items-center justify-center rounded-full border border-white/40 bg-black/30 transition hover:border-white hover:bg-white/15">
                {saved ? <Check className="size-4" /> : <Plus className="size-4" />}
              </button>
              {!item.available && !play && onDemand && <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200"><Zap className="size-3" /> Stream</span>}
              <Link href={cardHref(item)} aria-label="More info" className="ml-auto flex size-9 items-center justify-center rounded-full border border-white/40 bg-black/30 transition hover:border-white hover:bg-white/15"><ChevronDown className="size-4" /></Link>
            </div>
            <p className="line-clamp-1 text-sm font-semibold drop-shadow">{item.title}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/80">
              {d?.rating ? <span className="font-semibold text-emerald-400">{Math.round(d.rating * 10)}% match</span> : null}
              {d?.certification && <Badge>{d.certification}</Badge>}
              {(d?.year ?? item.year) && <span>{d?.year ?? item.year}</span>}
              {d?.runtime ? <span>{d.seasons ? `${d.seasons} season${d.seasons > 1 ? "s" : ""} · ` : ""}{fmtDuration(d.runtime * 60)}</span> : d?.seasons ? <span>{d.seasons} seasons</span> : null}
              {d?.genres?.length ? <span className="text-white/60">{d.genres.slice(0, 3).join(" • ")}</span> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={root}
      data-card-root
      data-expanded={expanded ? "" : undefined}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") schedule(); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") collapse(); }}
      // Keyboard / remote: dwelling on a card for the hover delay expands it like a mouse hover would.
      onFocus={(e) => { if ((e.target as HTMLElement).matches(":focus-visible") && !expanded) schedule(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) collapse(); }}
      style={cardBox}
      className={clsx(
        "relative shrink-0 transition-[width] duration-300 ease-out",
        inline ? "[--cw:118px] sm:[--cw:150px] lg:[--cw:178px]" : "w-full",
        !expanded && "has-[[data-card]:focus-visible]:z-20 has-[[data-card]:focus-visible]:scale-[1.06]",
        expanded && "z-30",
        className,
      )}
    >
      {body}
    </div>
  );
}

export function PosterSkeleton() {
  return <div className="skeleton aspect-[2/3] w-full" />;
}
