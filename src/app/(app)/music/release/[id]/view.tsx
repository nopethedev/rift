"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Play, Shuffle } from "lucide-react";
import { api, Button, Skeleton } from "@/components/ui";
import { Cover, TrackRow, type RowItem } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import { catInput, type CatAlbum, type CatTrack } from "@/lib/music-types";

interface Resp { album: CatAlbum & { label: string | null; genres: string[]; durationSec: number }; tracks: CatTrack[] }

/** An album from the online catalogue: tracklist with play, like and queue actions. Audio comes from the library or on-demand. */
export function ReleaseView({ id }: { id: string }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const { playItems, current, play } = useMusic();
  useEffect(() => { api<Resp>(`/api/music/online/album/${id}`).then(setD).catch((e: Error) => setErr(e.message)); }, [id]);
  if (err) return <p role="alert" className="text-red-300">{err}</p>;
  if (!d) return <Skeleton className="h-72" />;
  const { album: a, tracks } = d;
  const inputs = tracks.map(catInput);
  const mins = Math.round(a.durationSec / 60);
  const row = (t: CatTrack): RowItem => ({ key: t.id, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.artworkUrl });
  return (
    <div>
      <div className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-end">
        <Cover src={a.artworkUrl} className="aspect-square w-48 sm:w-60" rounded="rounded-2xl" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{a.kind === "single" ? "Single" : a.kind === "ep" ? "EP" : "Album"}</p>
          <h1 className="break-words text-3xl font-extrabold sm:text-5xl">{a.title}</h1>
          <p className="mt-2 text-sm text-white/80">
            {a.artistId ? <Link href={`/music/artists/${encodeURIComponent(a.artist)}?id=${a.artistId}`} className="font-semibold hover:underline">{a.artist}</Link> : a.artist}
            {[a.year, `${tracks.length} songs`, mins ? `${mins} min` : null].filter(Boolean).map((x) => <span key={String(x)} className="text-muted"> · {x}</span>)}
          </p>
          {(a.genres.length > 0 || a.label) && <p className="mt-1 text-xs text-muted">{[...a.genres, a.label].filter(Boolean).join(" · ")}</p>}
          <div className="mt-4 flex gap-2">
            <Button onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })} disabled={!tracks.length}><Play className="size-4 fill-current" /> Play</Button>
            <Button variant="secondary" onClick={() => playItems(inputs, { shuffle: true })} disabled={!tracks.length}><Shuffle className="size-4" /> Shuffle</Button>
          </div>
        </div>
      </div>
      {tracks.map((t, i) => <TrackRow key={t.id} item={row(t)} index={i} active={!!current && !!play && current.title === t.title && current.artist === t.artist} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
    </div>
  );
}
