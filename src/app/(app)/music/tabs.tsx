"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Home, Library, ListMusic, Search } from "lucide-react";

const TABS = [
  { href: "/music", label: "Home", icon: Home, exact: true },
  { href: "/music/library", label: "Library", icon: Library },
  { href: "/music/search", label: "Search", icon: Search },
  { href: "/music/playlists", label: "Playlists", icon: ListMusic },
];

export function MusicTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Music" className="no-scrollbar mb-6 flex gap-2 overflow-x-auto">
      {TABS.map((t) => {
        const on = t.exact ? path === t.href : path.startsWith(t.href) || (t.href === "/music/library" && /^\/music\/(albums|artists)/.test(path));
        return (
          <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className={clsx("flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition", on ? "bg-white text-black" : "bg-white/10 text-white/80 hover:bg-white/20")}>
            <t.icon className="size-4" /> {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
