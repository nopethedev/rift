"use client";
import { useRouter } from "next/navigation";
import { Clapperboard, Music2, Users } from "lucide-react";
import Link from "next/link";
import { Avatar, Logo } from "@/components/brand";

type App = "stream" | "music";
const APPS: { id: App; title: string; blurb: string; icon: typeof Music2; href: string }[] = [
  { id: "stream", title: "Stream", blurb: "Movies and TV shows", icon: Clapperboard, href: "/" },
  { id: "music", title: "Music", blurb: "Songs, albums and artists", icon: Music2, href: "/music" },
];

export function AppPicker({ profile, last, musicHint }: { profile: { name: string; avatar: string }; last: App | null; musicHint: string }) {
  const router = useRouter();
  function choose(a: (typeof APPS)[number]) {
    document.cookie = `rift_app=${a.id}; path=/; SameSite=Lax`; // session cookie: asked again next time the browser is opened
    document.cookie = `rift_app_last=${a.id}; path=/; SameSite=Lax; Max-Age=31536000`;
    router.replace(a.href);
  }
  return (
    <main className="flex min-h-dvh flex-col px-4 py-6">
      <header className="flex items-center justify-between">
        <Logo />
        <Link href="/profiles" className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm text-white/80 hover:bg-white/10 hover:text-white"><Avatar avatar={profile.avatar} size={28} className="rounded-full" /> {profile.name} <Users className="size-4 text-muted" /></Link>
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center">
        <h1 className="mb-6 text-2xl font-bold sm:text-3xl">What do you want to do?</h1>
        <div className="grid gap-3 sm:grid-cols-2">
          {APPS.map((a) => (
            <button
              key={a.id} autoFocus={a.id === (last ?? "stream")} data-focusable onClick={() => choose(a)}
              className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-surface p-5 text-left outline-none transition hover:border-white/30 hover:bg-white/[0.06] focus-visible:border-accent sm:flex-col sm:items-start sm:p-6"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-white/90 group-hover:text-white"><a.icon className="size-6" /></span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-xl font-bold">{a.title}{last === a.id && <span className="text-xs font-normal text-muted">last used</span>}</span>
                <span className="block text-sm text-muted">{a.id === "music" ? `${a.blurb} · ${musicHint}` : a.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted">You can switch from the menu at any time.</p>
      </div>
    </main>
  );
}
