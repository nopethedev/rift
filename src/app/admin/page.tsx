"use client";
import Link from "next/link";
import { Activity, Clapperboard, Download, Film, HardDrive, KeyRound, Tv, Users, Cpu, AlertTriangle } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { fmtBytes } from "@/lib/types";
import { Badge, Card, Skeleton } from "@/components/ui";
import { PageHeader } from "./parts";

interface Overview {
  users: number; movies: number; shows: number; episodes: number; files: number; unmatched: number; activeStreams: number;
  downloads: Record<string, number>; libraryBytes: number; transcodeSessions: number; tmdb: boolean;
  recent: { id: string; name: string; status: string; source: string; createdAt: string }[];
  worker: { ffmpeg: string; hwaccels: string[]; activeSessions: number; maxSessions: number } | null;
}

export default function AdminOverview() {
  const { data, loading } = usePoll<Overview>("/api/admin/overview", 5000);
  const activeDl = (data?.downloads.downloading ?? 0) + (data?.downloads.metadata ?? 0) + (data?.downloads.queued ?? 0);
  const stats = data && [
    { label: "Movies", value: data.movies, icon: Film, href: "/admin/media" },
    { label: "TV shows", value: `${data.shows} · ${data.episodes} eps`, icon: Tv, href: "/admin/media" },
    { label: "Active streams", value: data.activeStreams, icon: Activity, href: "/admin/streams" },
    { label: "Downloads", value: `${activeDl} active`, icon: Download, href: "/admin/downloads" },
    { label: "Library size", value: fmtBytes(data.libraryBytes), icon: HardDrive, href: "/admin/storage" },
    { label: "Users", value: data.users, icon: Users, href: "/admin/users" },
  ];
  return (
    <>
      <PageHeader title="Overview" subtitle="State of your Rift server." />
      {data && !data.tmdb && (
        <Link href="/admin/settings" className="mb-5 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 hover:bg-amber-500/15">
          <KeyRound className="size-5" /> TMDB is not configured — discovery, posters and automatic matching are disabled. Add an API key in Settings.
        </Link>
      )}
      {data && data.unmatched > 0 && (
        <Link href="/admin/media" className="mb-5 flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200 hover:bg-sky-500/15">
          <AlertTriangle className="size-5" /> {data.unmatched} file{data.unmatched > 1 ? "s" : ""} could not be matched automatically — review them in Media.
        </Link>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {loading || !stats ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />) : stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="h-full transition hover:border-accent/50">
              <s.icon className="mb-3 size-5 text-accent" />
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-sm text-muted">{s.label}</p>
            </Card>
          </Link>
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold"><Cpu className="size-4 text-accent" /> Transcoding worker</h2>
          {data?.worker ? (
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Status</dt><dd><Badge tone="green">online</Badge></dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">FFmpeg</dt><dd className="truncate text-right">{data.worker.ffmpeg}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Hardware encoders</dt><dd>{data.worker.hwaccels.join(", ") || "none (software)"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Sessions</dt><dd>{data.worker.activeSessions} / {data.worker.maxSessions}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-muted"><Badge tone="amber">offline</Badge> <span className="ml-2">Start it with <code className="rounded bg-black/40 px-1.5 py-0.5">npm run start:worker</code> (Docker: the <code>worker</code> service). Direct play and in-browser Mediabunny playback still work without it.</span></p>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold"><Clapperboard className="size-4 text-accent" /> Recently added files</h2>
          <ul className="space-y-2 text-sm">
            {data?.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3">
                <span className="truncate">{r.name}</span>
                <Badge tone={r.status === "ready" ? "green" : r.status === "unmatched" ? "amber" : "red"}>{r.status}</Badge>
              </li>
            ))}
            {data && !data.recent.length && <li className="text-muted">Nothing yet — <Link className="text-violet-300 hover:underline" href="/admin/media/new">add some media</Link>.</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
