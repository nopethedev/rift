"use client";
import { use } from "react";
import { Play, Shuffle } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { Button, Skeleton } from "@/components/ui";
import { AlbumCard, Grid, SectionTitle, TrackRow, trackRow } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import type { AlbumDTO, TrackDTO } from "@/lib/music-types";

export default function ArtistPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent(use(params).name);
  const tracks = usePoll<{ tracks: TrackDTO[]; total: number }>(`/api/music/library?kind=tracks&artist=${encodeURIComponent(name)}&take=200`);
  const albums = usePoll<{ albums: AlbumDTO[] }>(`/api/music/library?kind=albums&artist=${encodeURIComponent(name)}`);
  const { playItems, current, play } = useMusic();
  if (tracks.loading) return <Skeleton className="h-64" />;
  const list = tracks.data?.tracks ?? [];
  const inputs = list.map((t) => ({ trackId: t.id }));
  return (
    <div>
      <h1 className="text-3xl font-bold sm:text-4xl">{name}</h1>
      <p className="mb-4 text-sm text-muted">{tracks.data?.total ?? 0} tracks</p>
      <div className="mb-2 flex gap-2"><Button onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })} disabled={!list.length}><Play className="size-4 fill-current" /> Play</Button><Button variant="secondary" onClick={() => playItems(inputs, { shuffle: true })} disabled={!list.length}><Shuffle className="size-4" /> Shuffle</Button></div>
      {!!albums.data?.albums.length && <><SectionTitle>Albums</SectionTitle><Grid>{albums.data.albums.map((a) => <AlbumCard key={a.albumKey} a={a} />)}</Grid></>}
      <SectionTitle>Tracks</SectionTitle>
      {list.map((t, i) => <TrackRow key={t.id} item={trackRow(t)} index={i} active={current?.trackId === t.id && play?.kind === "local"} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
    </div>
  );
}
