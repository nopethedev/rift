"use client";
import { useEffect, useState } from "react";
import { Play, Shuffle } from "lucide-react";
import { api, Button, Skeleton } from "@/components/ui";
import { SectionTitle, TrackRow, type RowItem } from "@/components/music/parts";
import { CatAlbumCard, CatArtistCard, ShelfRow } from "@/components/music/cards";
import { useMusic } from "@/components/music/player-provider";
import { catInput, type CatAlbum, type CatArtist, type CatTrack } from "@/lib/music-types";

interface Resp { genre: { id: string; name: string }; tracks: CatTrack[]; albums: CatAlbum[]; artists: CatArtist[] }

export function GenreView({ id }: { id: string }) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const { playItems, current, play } = useMusic();
  useEffect(() => { api<Resp>(`/api/music/online/genre/${id}`).then(setD).catch((e: Error) => setErr(e.message)); }, [id]);
  if (err) return <p role="alert" className="text-red-300">{err}</p>;
  if (!d) return <Skeleton className="h-64" />;
  const inputs = d.tracks.map(catInput);
  const row = (t: CatTrack): RowItem => ({ key: t.id, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.artworkUrl });
  return (
    <div>
      <h1 className="text-4xl font-extrabold">{d.genre.name}</h1>
      <p className="mb-4 text-sm text-muted">Top songs, albums and artists right now</p>
      <div className="flex gap-2"><Button disabled={!inputs.length} onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })}><Play className="size-4 fill-current" /> Play</Button><Button variant="secondary" disabled={!inputs.length} onClick={() => playItems(inputs, { shuffle: true })}><Shuffle className="size-4" /> Shuffle</Button></div>
      {!!d.artists.length && <div className="mt-8"><ShelfRow title="Popular artists">{d.artists.map((a) => <CatArtistCard key={a.id} a={a} />)}</ShelfRow></div>}
      {!!d.albums.length && <div className="mt-8"><ShelfRow title="Top albums">{d.albums.map((a) => <CatAlbumCard key={a.id} a={a} />)}</ShelfRow></div>}
      {!!d.tracks.length && <><SectionTitle>Top songs</SectionTitle>{d.tracks.map((t, i) => <TrackRow key={t.id} item={row(t)} index={i} active={!!current && !!play && current.title === t.title && current.artist === t.artist} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}</>}
    </div>
  );
}
