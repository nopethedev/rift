"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { Gamepad2, Heart, Home, LayoutGrid, Library, ListMusic, LogOut, Plus, Search, Settings2, Shield, Users, X } from "lucide-react";
import { Avatar, Logo } from "../brand";
import { api } from "../ui";
import { Cover } from "./parts";
import { useMusic } from "./player-provider";
import { useSaved } from "./saved-provider";

interface PL { id: string; name: string; artworkUrl: string | null; count: number }

const NAV = [
  { href: "/music", label: "Home", icon: Home, exact: true },
  { href: "/music/search", label: "Search", icon: Search },
  { href: "/music/library", label: "Your Library", icon: Library, extra: /^\/music\/(albums|artists|artist|release)/ },
];
const isOn = (path: string, l: { href: string; exact?: boolean; extra?: RegExp }) => (l.exact ? path === l.href : path.startsWith(l.href) || !!l.extra?.test(path));

function usePlaylists() {
  const [lists, setLists] = useState<PL[]>([]);
  const path = usePathname();
  useEffect(() => { api<{ playlists: PL[] }>("/api/music/playlists").then((r) => setLists(r.playlists)).catch(() => {}); }, [path]);
  return lists;
}

/** Spotify-like chrome for the Music app: left sidebar (library, liked songs, playlists), top bar with search. */
export function MusicShell({ profile, isAdmin, children }: { profile: { name: string; avatar: string }; isAdmin: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { current } = useMusic();
  const saved = useSaved();
  const lists = usePlaylists();
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setMenu(false); if (!path.startsWith("/music/search")) setQ(""); }, [path]);

  const onSearch = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.replace(v.trim().length >= 2 ? `/music/search?q=${encodeURIComponent(v.trim())}` : "/music/search"), 350);
  };
  async function createPlaylist() {
    const name = prompt("Playlist name");
    if (!name?.trim()) return;
    const r = await api<{ id: string }>("/api/music/playlists", { method: "POST", body: { name } });
    router.push(`/music/playlists/${r.id}`);
  }
  async function signOut() { await api("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }

  return (
    <div className="min-h-dvh">
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 bg-bg/90 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] backdrop-blur sm:pl-4 sm:pr-4">
        <Link href="/apps" aria-label="Switch app" title="Switch app" className="hidden rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white md:block"><LayoutGrid className="size-5" /></Link>
        <Link href="/music" aria-label="Rift Music home" className="shrink-0"><Logo size={26} /></Link>
        <span className="hidden rounded-full bg-accent/20 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-violet-300 sm:block">Music</span>
        <div className="mx-auto hidden w-full max-w-md items-center gap-2 md:flex">
          <Link href="/music" aria-label="Home" className={clsx("rounded-full p-2.5 hover:bg-white/15", path === "/music" ? "bg-white/15" : "bg-white/10")}><Home className="size-5" /></Link>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input data-focusable aria-label="Search music" value={q} onChange={(e) => onSearch(e.target.value)} onFocus={() => !path.startsWith("/music/search") && router.push("/music/search")} placeholder="What do you want to play?" className="h-10 w-full rounded-full bg-white/10 pl-10 pr-9 text-sm outline-none ring-white/60 placeholder:text-white/45 focus:ring-2" />
            {q && <button aria-label="Clear search" onClick={() => onSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-white"><X className="size-4" /></button>}
          </div>
        </div>
        <div className="relative ml-auto md:ml-0">
          <button onClick={() => setMenu((m) => !m)} aria-label="Account menu" aria-expanded={menu} className="flex items-center rounded-full outline-none ring-accent focus-visible:ring-2"><Avatar avatar={profile.avatar} size={34} className="rounded-full" /></button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="glass absolute right-0 z-50 mt-3 w-56 overflow-hidden rounded-xl border border-white/10 py-1.5 text-sm shadow-2xl">
                <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3"><Avatar avatar={profile.avatar} size={32} className="rounded-full" /><span className="truncate font-semibold">{profile.name}</span></div>
                <Link href="/apps" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><LayoutGrid className="size-4" /> Switch app</Link>
                <Link href="/profiles" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Users className="size-4" /> Switch profile</Link>
                <Link href="/profiles?manage=1" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Settings2 className="size-4" /> Manage profiles</Link>
                <Link href="/discord" className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/10"><Gamepad2 className="size-4" /> Discord presence</Link>
                {isAdmin && <Link href="/admin/music" className="flex items-center gap-3 px-4 py-2.5 text-violet-300 hover:bg-white/10"><Shield className="size-4" /> Music admin</Link>}
                <button onClick={signOut} className="flex w-full items-center gap-3 border-t border-white/10 px-4 py-2.5 text-left hover:bg-white/10"><LogOut className="size-4" /> Sign out</button>
              </div>
            </>
          )}
        </div>
      </header>

      <aside aria-label="Library" className={clsx("fixed bottom-0 left-0 top-14 z-30 hidden w-64 flex-col gap-2 p-2 pr-0 md:flex", current && "pb-[4.75rem]")}>
        <nav aria-label="Music" className="rounded-xl bg-surface p-2">
          {NAV.slice(0, 2).map((l) => <SideLink key={l.href} {...l} on={isOn(path, l)} />)}
        </nav>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-surface">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <Link href="/music/library" className={clsx("flex items-center gap-2 text-sm font-semibold hover:text-white", isOn(path, NAV[2]) ? "text-white" : "text-white/70")}><Library className="size-5" /> Your Library</Link>
            <button onClick={createPlaylist} aria-label="Create playlist" title="Create playlist" className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white"><Plus className="size-5" /></button>
          </div>
          <ul className="no-scrollbar mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            <li><LibItem href="/music/liked" on={path.startsWith("/music/liked")} title="Liked songs" sub={`${saved.count} song${saved.count === 1 ? "" : "s"}`} cover={<span className="flex size-12 items-center justify-center rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-500"><Heart className="size-5 fill-white" /></span>} /></li>
            {lists.map((p) => <li key={p.id}><LibItem href={`/music/playlists/${p.id}`} on={path === `/music/playlists/${p.id}`} title={p.name} sub={`Playlist · ${p.count} songs`} cover={<Cover src={p.artworkUrl} className="size-12" rounded="rounded-md" />} /></li>)}
            <li><LibItem href="/music/playlists" on={path === "/music/playlists"} title="All playlists" sub="Create or import from Spotify" cover={<span className="flex size-12 items-center justify-center rounded-md bg-white/10"><ListMusic className="size-5" /></span>} /></li>
          </ul>
        </div>
      </aside>

      <main className="md:pl-64 md:pr-2">
        <div className="min-h-[calc(100dvh-3.5rem)] pt-14 md:mt-0 md:rounded-xl">
          <div className="bg-gradient-to-b from-accent/15 via-surface/60 to-surface/0 px-4 pb-28 pt-5 sm:px-8 md:min-h-[calc(100dvh-4rem)] md:rounded-xl md:pb-24">{children}</div>
        </div>
      </main>

      <nav aria-label="Main" className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-white/10 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden">
        {[{ href: "/music", label: "Home", icon: Home, exact: true }, NAV[1], { ...NAV[2], label: "Library" }, { href: "/music/liked", label: "Liked", icon: Heart }, { href: "/apps", label: "Apps", icon: LayoutGrid }].map((l) => {
          const on = l.href !== "/apps" && isOn(path, l as (typeof NAV)[number]);
          return (
            <Link key={l.href} href={l.href} aria-current={on ? "page" : undefined} className={clsx("flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] leading-none transition", on ? "font-semibold text-white" : "text-white/55")}>
              <l.icon className={clsx("size-5 transition", on && "scale-110 text-accent")} strokeWidth={on ? 2.4 : 2} />{l.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function SideLink({ href, label, icon: Icon, on }: { href: string; label: string; icon: typeof Home; on: boolean }) {
  return <Link href={href} data-focusable aria-current={on ? "page" : undefined} className={clsx("flex items-center gap-4 rounded-lg px-3 py-2.5 text-sm font-semibold transition", on ? "text-white" : "text-white/65 hover:text-white")}><Icon className="size-6" strokeWidth={on ? 2.6 : 2} /> {label}</Link>;
}
function LibItem({ href, on, title, sub, cover }: { href: string; on: boolean; title: string; sub: string; cover: React.ReactNode }) {
  return (
    <Link href={href} data-focusable aria-current={on ? "page" : undefined} className={clsx("flex items-center gap-3 rounded-lg p-2 transition", on ? "bg-white/10" : "hover:bg-white/5")}>
      {cover}
      <span className="min-w-0"><span className="block truncate text-sm font-medium">{title}</span><span className="block truncate text-xs text-muted">{sub}</span></span>
    </Link>
  );
}
