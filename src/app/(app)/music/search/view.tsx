"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CloudDownload, Loader2, Search } from "lucide-react";
import { api, Input } from "@/components/ui";
import { AlbumCard, ArtistCard, candidateRow, Empty, Grid, SectionTitle, TrackRow, trackRow, type RowItem } from "@/components/music/parts";
import { CatAlbumCard, CatArtistCard, ShelfRow } from "@/components/music/cards";
import { useMusic } from "@/components/music/player-provider";
import { catInput, type AlbumDTO, type ArtistDTO, type Candidate, type CatAlbum, type CatArtist, type CatTrack, type TrackDTO } from "@/lib/music-types";

export function SearchView() {
  const router = useRouter();
  const sp = useSearchParams();
  const urlQ = sp.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  useEffect(() => setQ(urlQ), [urlQ]); // the top-bar search box drives the URL
  const [lib, setLib] = useState<{ tracks: TrackDTO[]; albums: AlbumDTO[]; artists: ArtistDTO[] } | null>(null);
  const [cat, setCat] = useState<{ artists: CatArtist[]; albums: CatAlbum[]; tracks: CatTrack[] } | null>(null);
  const [od, setOd] = useState<{ loading: boolean; items: Candidate[]; error: string } | null>(null);
  const { playItems, current, play, mode } = useMusic();

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setLib(null); setOd(null); setCat(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      if (term !== urlQ) router.replace(`/music/search?q=${encodeURIComponent(term)}`);
      api<NonNullable<typeof cat>>(`/api/music/online/search?q=${encodeURIComponent(term)}`).then((r) => live && setCat(r)).catch(() => live && setCat(null));
      api<NonNullable<typeof lib>>(`/api/music/search?q=${encodeURIComponent(term)}`).then((r) => live && setLib(r)).catch(() => live && setLib({ tracks: [], albums: [], artists: [] }));
      if (mode?.onDemand) {
        setOd({ loading: true, items: [], error: "" });
        api<{ candidates: Candidate[] }>(`/api/music/search/ondemand?q=${encodeURIComponent(term)}`).then((r) => live && setOd({ loading: false, items: r.candidates, error: "" })).catch((e: Error) => live && setOd({ loading: false, items: [], error: e.message }));
      }
    }, 450);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, mode?.onDemand]);

  const inputs = lib?.tracks.map((t) => ({ trackId: t.id })) ?? [];
  const none = lib && !lib.tracks.length && !lib.albums.length && !lib.artists.length;
  return (
    <div>
      <div className="relative mb-6 max-w-xl md:hidden"><Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input aria-label="Search music" autoFocus placeholder="Songs, albums, artists" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" /></div>
      {!lib && !od && <Empty icon={Search} title="Search your music">{mode?.onDemand ? "Results from your library come first, then on-demand sources." : "Search your library by song, album or artist."}</Empty>}
      {lib && !!lib.artists.length && <><SectionTitle>Artists</SectionTitle><Grid>{lib.artists.map((a) => <ArtistCard key={a.artist} a={a} />)}</Grid></>}
      {lib && !!lib.albums.length && <><SectionTitle>Albums</SectionTitle><Grid>{lib.albums.map((a) => <AlbumCard key={a.albumKey} a={a} />)}</Grid></>}
      {lib && !!lib.tracks.length && <><SectionTitle>Songs in your library</SectionTitle>{lib.tracks.map((t, i) => <TrackRow key={t.id} item={trackRow(t)} onPlay={() => playItems(inputs, { startIndex: i, shuffle: false })} active={current?.trackId === t.id && play?.kind === "local"} />)}</>}
      {!!cat?.artists.length && <div className="mt-6"><ShelfRow title="Artists">{cat.artists.map((a) => <CatArtistCard key={a.id} a={a} />)}</ShelfRow></div>}
      {!!cat?.albums.length && <div className="mt-6"><ShelfRow title="Albums & singles">{cat.albums.map((a) => <CatAlbumCard key={a.id} a={a} />)}</ShelfRow></div>}
      {!!cat?.tracks.length && <><SectionTitle>Songs</SectionTitle>{cat.tracks.map((t, i) => { const row: RowItem = { key: t.id, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.artworkUrl }; return <TrackRow key={t.id} item={row} onPlay={() => playItems(cat.tracks.map(catInput), { startIndex: i, shuffle: false })} active={!!current && !!play && current.title === t.title && current.artist === t.artist} />; })}</>}
      {none && !mode?.onDemand && !cat?.tracks.length && <Empty title="No matches">Nothing in your library matches “{q}”.</Empty>}
      {od && (
        <>
          <SectionTitle><span className="flex items-center gap-2"><CloudDownload className="size-5 text-violet-300" /> On-demand</span></SectionTitle>
          {od.loading && <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Searching sources…</p>}
          {od.error && <p role="alert" className="text-sm text-amber-300">{od.error}</p>}
          {od.items.map((c) => <TrackRow key={c.sourceId} item={candidateRow(c)} onPlay={() => playItems([candidateRow(c).input], { startIndex: 0 })} active={current?.candidate?.sourceId === c.sourceId} />)}
          {!od.loading && !od.error && !od.items.length && <p className="text-sm text-muted">No results from the enabled sources.</p>}
          {!od.loading && !!od.items.length && <p className="mt-2 text-xs text-muted">Playback checks the source&apos;s licence first; tracks that can&apos;t be streamed legally on this server will report why.</p>}
        </>
      )}
    </div>
  );
}
