"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Clapperboard, Music2, Users } from "lucide-react";
import Link from "next/link";
import clsx from "clsx";
import { Avatar, Logo } from "@/components/brand";

type App = "stream" | "music";
const APPS: { id: App; title: string; blurb: string; icon: typeof Music2; href: string; tint: string; glow: string }[] = [
  { id: "stream", title: "Stream", blurb: "Movies and TV shows", icon: Clapperboard, href: "/", tint: "from-violet-600 via-violet-700 to-indigo-900", glow: "group-hover:shadow-violet-500/40" },
  { id: "music", title: "Music", blurb: "Songs, albums and artists", icon: Music2, href: "/music", tint: "from-fuchsia-500 via-purple-700 to-violet-900", glow: "group-hover:shadow-fuchsia-500/40" },
];

export function AppPicker({ profile, last, musicHint }: { profile: { name: string; avatar: string }; last: App | null; musicHint: string }) {
  const router = useRouter();
  const first = useRef<HTMLButtonElement>(null);
  function choose(a: (typeof APPS)[number]) {
    document.cookie = `rift_app=${a.id}; path=/; SameSite=Lax`; // session cookie: asked again next time the browser is opened
    document.cookie = `rift_app_last=${a.id}; path=/; SameSite=Lax; Max-Age=31536000`;
    router.replace(a.href);
  }
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Logo className="absolute left-6 top-6" />
      <Link href="/profiles" className="absolute right-6 top-6 flex items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-sm hover:bg-white/20"><Avatar avatar={profile.avatar} size={28} className="rounded-full" /> {profile.name} <Users className="size-4 text-muted" /></Link>
      <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-2 text-3xl font-bold sm:text-5xl">What do you want to do?</motion.h1>
      <p className="mb-10 text-muted">Pick an app. You can switch any time from the menu.</p>
      <div className="grid w-full max-w-3xl gap-5 sm:grid-cols-2">
        {APPS.map((a, i) => (
          <motion.button
            key={a.id} ref={i === 0 ? first : undefined} autoFocus={a.id === (last ?? "stream")} data-focusable
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.07 }} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}
            onClick={() => choose(a)}
            className={clsx("group relative flex aspect-[16/10] flex-col justify-end overflow-hidden rounded-3xl bg-gradient-to-br p-6 text-left shadow-2xl outline-none ring-2 ring-transparent transition focus-visible:ring-white", a.tint, a.glow)}
          >
            <a.icon aria-hidden className="absolute -right-6 -top-6 size-48 rotate-12 text-white/15 transition group-hover:rotate-6 group-hover:scale-110" strokeWidth={1.25} />
            {last === a.id && <span className="absolute left-5 top-5 rounded-full bg-black/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide">Last used</span>}
            <a.icon className="mb-3 size-9" />
            <span className="text-3xl font-extrabold">{a.title}</span>
            <span className="text-sm text-white/80">{a.id === "music" ? `${a.blurb} · ${musicHint}` : a.blurb}</span>
          </motion.button>
        ))}
      </div>
    </main>
  );
}
