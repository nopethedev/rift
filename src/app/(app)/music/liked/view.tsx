"use client";
import { useEffect, useState } from "react";
import { Heart, Play, Shuffle } from "lucide-react";
import { api, Button, Skeleton } from "@/components/ui";
import { Empty, TrackRow, type RowItem } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import { useSaved } from "@/components/music/saved-provider";
import type { ItemInput, SavedDTO } from "@/lib/music-types";

const inputOf = (s: SavedDTO): ItemInput => (s.trackId ? { trackId: s.trackId } : { title: s.title, artist: s.artist, album: s.album, durationSec: s.durationSec, artworkUrl: s.artworkUrl });

/** The profile's saved songs. Songs without a library file are streamed on demand; unmatched ones can be matched by hand. */
export function LikedView() {
  const [items, setItems] = useState<SavedDTO[] | null>(null);
  const [error, setError] = useState("");
  const { playItems, current, play } = useMusic();
  const { version } = useSaved();
  const [local, setLocal] = useState(0);
  useEffect(() => { api<{ items: SavedDTO[] }>("/api/music/saved").then((r) => setItems(r.items)).catch((e: Error) => setError(e.message)); }, [version, local]);

  if (error) return <p role="alert" className="text-red-300">{error}</p>;
  if (!items) return <div className="space-y-3"><Skeleton className="h-24" />{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  const inputs = items.map(inputOf);
  const rowOf = (s: SavedDTO): RowItem => ({
    key: s.id, title: s.title, artist: s.artist, album: s.album, durationSec: s.durationSec, cover: s.artworkUrl ?? s.track?.coverUrl ?? null, trackId: s.trackId ?? undefined, input: inputOf(s),
    note: s.match === "local" ? "Library" : s.match === "ondemand" ? "Matched" : undefined,
    onMatch: async (pick) => { await api(`/api/music/saved/${s.id}`, { method: "PATCH", body: pick }); setLocal((n) => n + 1); },
  });
  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex size-44 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-500 sm:size-52"><Heart className="size-20 fill-white text-white" /></div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Playlist</p>
          <h1 className="text-3xl font-bold sm:text-5xl">Liked songs</h1>
          <p className="mt-1 text-sm text-white/80">{items.length} song{items.length === 1 ? "" : "s"} · your saved library</p>
          <div className="mt-4 flex gap-2">
            <Button disabled={!items.length} onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })}><Play className="size-4 fill-current" /> Play</Button>
            <Button variant="secondary" disabled={!items.length} onClick={() => playItems(inputs, { shuffle: true })}><Shuffle className="size-4" /> Shuffle</Button>
          </div>
        </div>
      </div>
      {!items.length && <Empty icon={Heart} title="Nothing here yet">Tap the heart on any song, in search, playlists, albums or the player, to keep it in your library.</Empty>}
      {items.map((s, i) => <TrackRow key={s.id} item={rowOf(s)} index={i} active={!!current && !!play && ((s.trackId && current.trackId === s.trackId) || (current.title === s.title && current.artist === s.artist))} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
    </div>
  );
}
