"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { Bookmark, Clapperboard, Gamepad2, Home, LayoutGrid, LogOut, Search, Settings2, Tv, Users, X } from "lucide-react";
import { Avatar, Logo } from "./brand";
import { api } from "./ui";
import { isTvMode, setTvMode } from "./spatial-nav";

const LINKS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/browse/tv", label: "TV Shows", icon: Tv },
  { href: "/browse/movies", label: "Movies", icon: Clapperboard },
  { href: "/my-list", label: "My List", icon: Bookmark },
];

export function Navbar({ profile, isAdmin }: { profile: { name: string; avatar: string }; isAdmin: boolean }) {
  const path = usePathname();
  const router = useRouter();
  const [solid, setSolid] = useState(false);
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [tv, setTv] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const on = () => setSolid(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => { if (searching) input.current?.focus(); }, [searching]);
  useEffect(() => { setMenu(false); if (!path.startsWith("/search")) { setQ(""); setSearching(false); } }, [path]);

  const onSearch = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => (v.trim().length >= 2 ? router.replace(`/search?q=${encodeURIComponent(v.trim())}`) : v === "" && path.startsWith("/search") && router.replace("/")), 300);
  };

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav className={clsx("fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:gap-6 transition-colors duration-300 sm:px-12", solid ? "bg-bg/95 shadow-lg backdrop-blur" : "bg-gradient-to-b from-black/80 to-transparent")}>
      <Link href="/" aria-label="Rift home" className={clsx("shrink-0", searching && "hidden sm:block")}><Logo /></Link>
      <ul className="hidden items-center gap-5 text-sm md:flex">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={clsx("transition hover:text-white", (l.href === "/" ? path === "/" : path.startsWith(l.href)) ? "font-semibold text-white" : "text-white/65")}>{l.label}</Link>
          </li>
        ))}
      </ul>
      <div className={clsx("flex min-w-0 items-center gap-3", searching ? "flex-1 justify-end" : "ml-auto")}>
        <div className={clsx("flex items-center overflow-hidden rounded-lg border transition-all", searching ? "min-w-0 flex-1 border-white/40 bg-black/60 sm:w-64 sm:flex-none" : "w-9 border-transparent")}>
          <button aria-label="Search" onClick={() => setSearching(true)} className="flex size-9 shrink-0 items-center justify-center"><Search className="size-5" /></button>
          {searching && (
            <>
              <input ref={input} value={q} onChange={(e) => onSearch(e.target.value)} onBlur={() => !q && setSearching(false)} placeholder="Titles, people, genres" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-white/40" />
              {q && <button aria-label="Clear" onClick={() => { setQ(""); input.current?.focus(); }} className="px-2"><X className="size-4" /></button>}
            </>
          )}
        </div>
        <div className="relative">
          <button onClick={() => { setTv(isTvMode()); setMenu((m) => !m); }} aria-label="Account menu" aria-expanded={menu} className="flex items-center rounded-md outline-none ring-accent focus-visible:ring-2"><Avatar avatar={profile.avatar} size={34} className="m-[3px]" /></button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="glass absolute right-0 z-50 mt-3 w-56 overflow-hidden rounded-xl border border-white/10 py-1.5 text-sm shadow-2xl">
                <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3"><Avatar avatar={profile.avatar} size={32} /><span className="truncate font-semibold">{profile.name}</span></div>
                <Link href="/apps" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><LayoutGrid className="size-4" /> Switch app</Link>
                <Link href="/profiles" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Users className="size-4" /> Switch profile</Link>
                <Link href="/profiles?manage=1" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Settings2 className="size-4" /> Manage profiles</Link>
                <Link href="/discord" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Gamepad2 className="size-4" /> Discord presence</Link>
                {isAdmin && <Link href="/admin" className="flex items-center gap-3 px-4 py-2.5 text-violet-300 hover:bg-white/10"><Settings2 className="size-4" /> Admin dashboard</Link>}
                <button onClick={() => { setTvMode(!tv); setTv(!tv); }} role="switch" aria-checked={tv} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-white/10">
                  <Tv className="size-4" /> TV mode <span className={clsx("ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", tv ? "bg-accent text-white" : "bg-white/10 text-white/50")}>{tv ? "On" : "Off"}</span>
                </button>
                <button onClick={signOut} className="flex w-full items-center gap-3 border-t border-white/10 px-4 py-2.5 text-left hover:bg-white/10"><LogOut className="size-4" /> Sign out</button>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

/** Bottom tab bar for small screens (the top links are hidden below md): icon above label. */
export function MobileTabs() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-white/10 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden">
      {LINKS.map((l) => {
        const on = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined} className={clsx("flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] leading-none transition", on ? "font-semibold text-white" : "text-white/55")}>
            <l.icon className={clsx("size-5 transition", on && "scale-110 text-accent")} strokeWidth={on ? 2.4 : 2} />
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
