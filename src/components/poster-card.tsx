"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Library, Play } from "lucide-react";
import { type CardItem, tmdbImg } from "@/lib/types";
import { cardHref } from "@/lib/links";
import { useApp } from "./providers";
import { ProgressBar } from "./ui";

const HOVER_DELAY_MS = 700;

export function PosterCard({ item, className }: { item: CardItem; className?: string }) {
  const { openPreview, closePreview } = useApp();
  const ref = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [broken, setBroken] = useState(false);
  const src = broken ? null : tmdbImg(item.posterPath, "w342");
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const open = (sheet: boolean) => {
    if (ref.current && item.tmdbId) openPreview(item, ref.current.getBoundingClientRect(), sheet);
  };

  return (
    <Link
      ref={ref}
      href={cardHref(item)}
      data-card
      className={clsx("group/card relative block aspect-[2/3] w-full shrink-0 overflow-hidden rounded-lg bg-surface outline-none transition-transform duration-200 focus-visible:scale-[1.07]", className)}
      // Keyboard / remote: dwelling on a card for the hover delay opens the same preview a mouse would.
      onFocus={(e) => { if (!e.currentTarget.matches(":focus-visible")) return; clear(); timer.current = setTimeout(() => open(false), HOVER_DELAY_MS); }}
      onBlur={() => { clear(); closePreview(160); }}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        clear();
        timer.current = setTimeout(() => open(false), HOVER_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        clear();
        closePreview(140);
      }}
      onClick={(e) => {
        // Touch devices: first tap opens the preview sheet instead of navigating.
        if (window.matchMedia("(hover: none)").matches && item.tmdbId) {
          e.preventDefault();
          open(true);
        }
      }}
    >
      {src ? (
        <img src={src} alt={item.title} loading="lazy" draggable={false} onError={() => setBroken(true)} className={clsx("size-full object-cover transition duration-300", !item.available && "saturate-[.8]")} />
      ) : (
        <div className="flex size-full items-center justify-center bg-surface-2 p-3 text-center text-sm text-muted">{item.title}</div>
      )}
      <div className="absolute left-1.5 top-1.5">
        {item.available ? (
          <span className="flex items-center gap-1 rounded-md bg-accent/90 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow"><Library className="size-3" /> In library</span>
        ) : (
          <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70 backdrop-blur">Discover</span>
        )}
      </div>
      {item.available && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover/card:bg-black/30 group-hover/card:opacity-100">
          <Play className="size-9 fill-white drop-shadow" />
        </span>
      )}
      {(item.progress || item.subtitle) && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 pt-8">
          {item.subtitle && <p className="mb-1 truncate text-[11px] text-white/80">{item.subtitle}</p>}
          {item.progress && item.progress.duration > 0 && <ProgressBar value={item.progress.position / item.progress.duration} />}
        </div>
      )}
    </Link>
  );
}

export function PosterSkeleton() {
  return <div className="skeleton aspect-[2/3] w-full" />;
}
