"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { SEARCH_DELAY_MS } from "@/lib/use-debounced";
import { Play, Shuffle } from "lucide-react";
import { api, Button, Input, Skeleton } from "@/components/ui";
import { AlbumCard, ArtistCard, Empty, Grid, TrackRow, trackRow } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import type { AlbumDTO, ArtistDTO, TrackDTO } from "@/lib/music-types";

const PAGE = 100;
type Tab = "tracks" | "albums" | "artists";

export function LibraryView() {
  const [tab, setTab] = useState<Tab>("albums");
  const [q, setQ] = useState("");
  const [tracks, setTracks] = useState<TrackDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [albums, setAlbums] = useState<AlbumDTO[]>([]);
  const [artists, setArtists] = useState<ArtistDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const { playItems, current, play } = useMusic();

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    const qs = new URLSearchParams({ kind: tab, take: String(tab === "tracks" ? PAGE : 200), skip: String(reset || tab !== "tracks" ? 0 : tracks.length) });
    if (q.trim()) qs.set("q", q.trim());
    try {
      const r = await api<{ tracks?: TrackDTO[]; total?: number; albums?: AlbumDTO[]; artists?: ArtistDTO[] }>(`/api/music/library?${qs}`);
      if (tab === "tracks") { setTracks((cur) => (reset ? r.tracks! : [...cur, ...r.tracks!])); setTotal(r.total ?? 0); }
      else if (tab === "albums") setAlbums(r.albums ?? []);
      else setArtists(r.artists ?? []);
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, tracks.length]);
  useEffect(() => { const t = setTimeout(() => void load(true), q ? SEARCH_DELAY_MS : 0); return () => clearTimeout(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, q]);

  const inputs = tracks.map((t) => ({ trackId: t.id }));
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full bg-white/5 p-1" role="tablist">
          {(["albums", "artists", "tracks"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx("rounded-full px-4 py-2.5 text-sm font-medium capitalize pointer-fine:py-1.5", tab === t ? "bg-accent text-white" : "text-white/70 hover:text-white")}>{t}</button>)}
        </div>
        <div className="w-full sm:w-72"><Input aria-label="Filter library" placeholder={`Filter ${tab}`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {loading && !tracks.length && !albums.length && !artists.length && <Skeleton className="h-64" />}
      {tab === "albums" && (albums.length ? <Grid>{albums.map((a) => <AlbumCard key={a.albumKey} a={a} />)}</Grid> : !loading && <Empty title="No albums found">Songs without an album tag appear under Tracks.</Empty>)}
      {tab === "artists" && (artists.length ? <Grid>{artists.map((a) => <ArtistCard key={a.artist} a={a} />)}</Grid> : !loading && <Empty title="No artists found" />)}
      {tab === "tracks" && (
        tracks.length ? (
          <>
            <div className="mb-3 flex gap-2"><Button size="sm" onClick={() => playItems(inputs, { startIndex: 0, shuffle: false })}><Play className="size-4 fill-current" /> Play all</Button><Button size="sm" variant="secondary" onClick={() => playItems(inputs, { shuffle: true })}><Shuffle className="size-4" /> Shuffle</Button><span className="self-center text-sm text-muted">{total} tracks</span></div>
            {tracks.map((t, i) => <TrackRow key={t.id} item={trackRow(t)} index={i} active={current?.trackId === t.id && play?.kind === "local"} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} />)}
            {tracks.length < total && <div className="mt-4 text-center"><Button variant="secondary" loading={loading} onClick={() => load(false)}>Load more</Button></div>}
          </>
        ) : !loading && <Empty title="No tracks found" />
      )}
    </div>
  );
}
