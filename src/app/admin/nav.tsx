"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Activity, ArrowLeft, Download, Film, HardDrive, LayoutDashboard, Music2, PlusCircle, Settings, SlidersHorizontal, Users } from "lucide-react";
import { Logo } from "@/components/brand";

const ITEMS = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/media", label: "Media", icon: Film },
  { href: "/admin/media/new", label: "Add media", icon: PlusCircle, exact: true },
  { href: "/admin/downloads", label: "Downloads", icon: Download },
  { href: "/admin/music", label: "Music", icon: Music2, exact: true },
  { href: "/admin/music/settings", label: "Music settings", icon: SlidersHorizontal },
  { href: "/admin/streams", label: "Active streams", icon: Activity },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/storage", label: "Storage", icon: HardDrive },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminNav({ username }: { username: string }) {
  const path = usePathname();
  const active = (i: (typeof ITEMS)[number]) => (i.exact ? path === i.href : path.startsWith(i.href) && !(i.href === "/admin/media" && path.startsWith("/admin/media/new")));
  return (
    <aside className="border-b border-line bg-surface/60 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between px-5 py-4 lg:block">
        <Logo />
        <p className="hidden text-xs text-muted lg:mt-1 lg:block">Admin · {username}</p>
        <Link href="/" className="flex items-center gap-1 text-sm text-muted hover:text-white lg:hidden"><ArrowLeft className="size-4" /> Back to Rift</Link>
      </div>
      <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-0">
        {ITEMS.map((i) => (
          <Link key={i.href} href={i.href} className={clsx("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active(i) ? "bg-accent/20 font-semibold text-white" : "text-white/65 hover:bg-white/5 hover:text-white")}>
            <i.icon className={clsx("size-4", active(i) && "text-accent")} /> {i.label}
          </Link>
        ))}
      </nav>
      <Link href="/" className="absolute bottom-5 left-5 hidden items-center gap-2 text-sm text-muted hover:text-white lg:flex"><ArrowLeft className="size-4" /> Back to Rift</Link>
    </aside>
  );
}
