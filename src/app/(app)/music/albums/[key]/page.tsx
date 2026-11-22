"use client";
import { use } from "react";
import { Play, Shuffle } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { Button, Skeleton } from "@/components/ui";
import { Cover, TrackRow, trackRow } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import { fmtTime, type TrackDTO } from "@/lib/music-types";

interface Album { album: string; artist: string; year: number | null; genre: string | null; coverUrl: string | null; durationSec: number; tracks: TrackDTO[] }

export default function AlbumPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { data, loading, error } = usePoll<Album>(`/api/music/library/albums/${key}`);
  const { playItems, current, play } = useMusic();
  if (loading) return <Skeleton className="h-64" />;
  if (error || !data) return <p role="alert" className="text-red-300">{error || "Album not found"}</p>;
  const inputs = data.tracks.map((t) => ({ trackId: t.id }));
  return (
    <div>
      <div className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-end">
        <Cover src={data.coverUrl} className="aspect-square w-48 sm:w-56" rounded="rounded-2xl" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Album</p>
          <h1 className="text-3xl font-bold sm:text-4xl">{data.album}</h1>
          <p className="mt-1 text-sm text-white/80">{data.artist}{data.year ? ` · ${data.year}` : ""}{data.genre ? ` · ${data.genre}` : ""} · {data.tracks.length} tracks · {fmtTime(data.durationSec)}</p>
          <div className="mt-4 flex gap-2"><Button onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })}><Play className="size-4 fill-current" /> Play</Button><Button variant="secondary" onClick={() => playItems(inputs, { shuffle: true })}><Shuffle className="size-4" /> Shuffle</Button></div>
        </div>
      </div>
      {data.tracks.map((t, i) => <TrackRow key={t.id} item={trackRow(t, { cover: t.coverUrl ?? data.coverUrl })} index={i} active={current?.trackId === t.id && play?.kind === "local"} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
    </div>
  );
}
