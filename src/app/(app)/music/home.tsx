"use client";
import Link from "next/link";
import { CloudDownload, Play, Shuffle, Upload } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import type { MusicMode, TrackDTO } from "@/lib/music-types";
import { Button, Skeleton } from "@/components/ui";
import { Empty, SectionTitle, TrackRow, trackRow } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";

interface Home { mode: MusicMode; stats: { tracks: number; albums: number; artists: number }; madeForYou: TrackDTO[]; recentlyPlayed: TrackDTO[]; recentlyAdded: TrackDTO[] }

function Block({ title, tracks, canShuffle }: { title: string; tracks: TrackDTO[]; canShuffle?: boolean }) {
  const { playItems, current, play } = useMusic();
  if (!tracks.length) return null;
  const inputs = tracks.map((t) => ({ trackId: t.id }));
  return (
    <section>
      <SectionTitle action={<div className="flex gap-2"><Button size="sm" onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })}><Play className="size-4 fill-current" /> Play</Button>{canShuffle && <Button size="sm" variant="secondary" onClick={() => playItems(inputs, { shuffle: true })}><Shuffle className="size-4" /> Shuffle</Button>}</div>}>{title}</SectionTitle>
      <div className="grid gap-x-6 md:grid-cols-2">
        {tracks.slice(0, 10).map((t, i) => <TrackRow key={t.id} item={trackRow(t)} index={i} active={current?.trackId === t.id && play?.kind === "local"} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
      </div>
    </section>
  );
}

export function MusicHome({ isAdmin }: { isAdmin: boolean }) {
  const { data, loading, error } = usePoll<Home>("/api/music/home");
  if (loading) return <div className="space-y-3"><Skeleton className="h-10 w-64" />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (error || !data) return <p role="alert" className="text-red-300">{error || "Could not load music"}</p>;
  const { mode, stats } = data;
  const empty = stats.tracks === 0;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-bold">Music</h1><p className="text-sm text-muted">{stats.tracks} tracks · {stats.albums} albums · {stats.artists} artists{mode.onDemand ? " · on-demand streaming on" : ""}</p></div>
        {isAdmin && <Link href="/admin/music"><Button variant="secondary" size="sm"><Upload className="size-4" /> Manage library</Button></Link>}
      </div>
      {mode.source !== "local" && !mode.onDemand && mode.onDemandReason && <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{mode.onDemandReason}</p>}
      {empty && !mode.onDemand && <Empty title="Your music library is empty">{isAdmin ? <>Upload songs or point Rift at a music folder in <Link href="/admin/music" className="text-violet-300 underline">Admin → Music</Link>.</> : "Ask an administrator to add music."}</Empty>}
      {empty && mode.onDemand && <Empty icon={CloudDownload} title="Search for anything">On-demand streaming is on: <Link href="/music/search" className="text-violet-300 underline">search</Link> for a song, or import a Spotify playlist under <Link href="/music/playlists" className="text-violet-300 underline">Playlists</Link>.</Empty>}
      <Block title="Made for you" tracks={data.madeForYou} canShuffle />
      <Block title="Recently played" tracks={data.recentlyPlayed} />
      <Block title="Recently added" tracks={data.recentlyAdded} />
    </div>
  );
}
