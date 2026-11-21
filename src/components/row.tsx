"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CardItem } from "@/lib/types";
import { PosterCard } from "./poster-card";

/** Horizontal carousel with scroll-snap and edge-aware arrows. */
export function Row({ title, items, href }: { title: string; items: CardItem[]; href?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: true });
  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 8, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8 });
  }, []);
  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update, items]);

  if (!items.length) return null;
  const page = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.9, behavior: "smooth" });

  return (
    <section className="group/row relative">
      <h2 className="mb-2.5 px-4 text-lg font-semibold tracking-tight sm:px-12 sm:text-xl">{title}</h2>
      <div className="relative">
        {edge.left && (
          <button tabIndex={-1} aria-label="Scroll left" onClick={() => page(-1)} className="absolute inset-y-0 left-0 z-10 hidden w-12 items-center justify-center bg-gradient-to-r from-bg to-transparent opacity-0 transition group-hover/row:opacity-100 sm:flex">
            <ChevronLeft className="size-8" />
          </button>
        )}
        <div ref={scroller} onScroll={update} className="no-scrollbar flex snap-x gap-2.5 overflow-x-auto scroll-smooth px-4 py-3 sm:px-12">
          {items.map((it) => (
            <div key={it.key} className="w-[118px] shrink-0 snap-start sm:w-[150px] lg:w-[178px]">
              <PosterCard item={it} />
            </div>
          ))}
        </div>
        {edge.right && (
          <button tabIndex={-1} aria-label="Scroll right" onClick={() => page(1)} className="absolute inset-y-0 right-0 z-10 hidden w-12 items-center justify-center bg-gradient-to-l from-bg to-transparent opacity-0 transition group-hover/row:opacity-100 sm:flex">
            <ChevronRight className="size-8" />
          </button>
        )}
      </div>
    </section>
  );
}

export function RowSkeleton() {
  return (
    <div>
      <div className="skeleton mx-4 mb-3 h-6 w-48 sm:mx-12" />
      <div className="flex gap-2.5 overflow-hidden px-4 sm:px-12">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="skeleton aspect-[2/3] w-[118px] shrink-0 sm:w-[150px] lg:w-[178px]" />
        ))}
      </div>
    </div>
  );
}
