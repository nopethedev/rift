"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CloudDownload, Heart, Play, Upload } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { api, Button, Skeleton } from "@/components/ui";
import { Cover, Empty } from "@/components/music/parts";
import { CatAlbumCard, CatArtistCard, CatTrackCard, LocalTrackCard, ShelfRow } from "@/components/music/cards";
import { useMusic } from "@/components/music/player-provider";
import { useSaved } from "@/components/music/saved-provider";
import { BackgroundPlaybackTip } from "@/components/music/background-playback";
import type { Feed, MusicMode, TrackDTO } from "@/lib/music-types";

interface Home { mode: MusicMode; stats: { tracks: number; albums: number; artists: number }; madeForYou: TrackDTO[]; recentlyPlayed: TrackDTO[]; recentlyAdded: TrackDTO[] }
interface PL { id: string; name: string; artworkUrl: string | null; count: number }

const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

function QuickTile({ href, title, cover, onPlay }: { href: string; title: string; cover: React.ReactNode; onPlay?: () => void }) {
  return (
    <div className="group relative flex items-center overflow-hidden rounded-md bg-white/10 transition hover:bg-white/20">
      <Link href={href} data-focusable className="flex min-w-0 flex-1 items-center gap-3 outline-none">{cover}<span className="truncate pr-12 text-sm font-bold">{title}</span></Link>
      {onPlay && <button aria-label={`Play ${title}`} onClick={onPlay} className="absolute right-2 flex size-9 translate-y-1 items-center justify-center rounded-full bg-accent opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100 focus-visible:opacity-100"><Play className="ml-0.5 size-4 fill-current" /></button>}
    </div>
  );
}

export function MusicHome({ name, isAdmin }: { name: string; isAdmin: boolean }) {
  const { data, loading, error } = usePoll<Home>("/api/music/home");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedErr, setFeedErr] = useState("");
  const [lists, setLists] = useState<PL[]>([]);
  const { playPlaylist } = useMusic();
  const saved = useSaved();
  useEffect(() => {
    api<Feed>("/api/music/feed").then(setFeed).catch((e: Error) => setFeedErr(e.message));
    api<{ playlists: PL[] }>("/api/music/playlists").then((r) => setLists(r.playlists)).catch(() => {});
  }, []);

  if (loading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div></div>;
  if (error || !data) return <p role="alert" className="text-red-300">{error || "Could not load music"}</p>;
  const { mode, stats } = data;
  const empty = stats.tracks === 0;

  // Quick picks: Liked songs, your playlists, then albums you played lately.
  const seen = new Set<string>();
  const albums = data.recentlyPlayed.filter((t) => t.album && !seen.has(t.albumKey) && seen.add(t.albumKey));
  return (
    <div>
      <BackgroundPlaybackTip />
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold">{greeting()}, {name}</h1>
        {isAdmin && <Link href="/admin/music"><Button variant="secondary" size="sm"><Upload className="size-4" /> Manage library</Button></Link>}
      </div>
      {mode.source !== "local" && !mode.onDemand && mode.onDemandReason && <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{mode.onDemandReason}</p>}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <QuickTile href="/music/liked" title="Liked songs" cover={<span className="flex size-14 shrink-0 items-center justify-center bg-gradient-to-br from-violet-600 to-fuchsia-500"><Heart className="size-6 fill-white" /></span>} />
        {lists.slice(0, 4).map((p) => <QuickTile key={p.id} href={`/music/playlists/${p.id}`} title={p.name} cover={<Cover src={p.artworkUrl} className="size-14" rounded="rounded-none" />} onPlay={p.count ? () => void playPlaylist(p.id) : undefined} />)}
        {albums.slice(0, Math.max(0, 7 - lists.slice(0, 4).length)).map((t) => <QuickTile key={t.albumKey} href={`/music/albums/${t.albumKey}`} title={t.album!} cover={<Cover src={t.coverUrl} className="size-14" rounded="rounded-none" />} />)}
      </div>

      {empty && !mode.onDemand && !feed?.shelves.length && <Empty title="Your music library is empty">{isAdmin ? <>Upload songs or point Rift at a music folder in <Link href="/admin/music" className="text-violet-300 underline">Admin → Music</Link>.</> : "Ask an administrator to add music."}</Empty>}

      {!!data.madeForYou.length && <ShelfRow title="Made for you" subtitle="Based on what you play">{data.madeForYou.map((t, i) => <LocalTrackCard key={t.id} t={t} all={data.madeForYou} index={i} />)}</ShelfRow>}
      {!!data.recentlyPlayed.length && <ShelfRow title="Recently played">{data.recentlyPlayed.map((t, i) => <LocalTrackCard key={t.id} t={t} all={data.recentlyPlayed} index={i} />)}</ShelfRow>}
      {!!data.recentlyAdded.length && <ShelfRow title="Recently added to your library">{data.recentlyAdded.map((t, i) => <LocalTrackCard key={t.id} t={t} all={data.recentlyAdded} index={i} />)}</ShelfRow>}

      {!feed && !feedErr && <div className="mt-8 space-y-3"><Skeleton className="h-6 w-48" /><div className="flex gap-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-52 w-44 shrink-0" />)}</div></div>}
      {feed?.shelves.map((s) => (
        <ShelfRow key={s.id} title={s.title} subtitle={s.subtitle} href={s.href}>
          {s.tracks?.map((t, i) => <CatTrackCard key={t.id} t={t} all={s.tracks!} index={i} />)}
          {s.albums?.map((a) => <CatAlbumCard key={a.id} a={a} />)}
          {s.artists?.map((a) => <CatArtistCard key={a.id} a={a} />)}
        </ShelfRow>
      ))}
      {feed && !feed.enabled && <p className="mt-8 rounded-lg bg-white/5 px-3 py-2 text-sm text-muted">Charts, new releases and artist info are switched off. {isAdmin ? <>Turn on “Online album art, artist info and music feed” in <Link href="/admin/music/settings" className="text-violet-300 underline">Music settings</Link>.</> : "An administrator can turn them on."}</p>}
      {(feedErr || feed?.error) && <p role="status" className="mt-8 flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-muted"><CloudDownload className="size-4 shrink-0" /> Couldn&apos;t load the online feed: {feedErr || feed?.error}</p>}
      {!!feed?.genres.length && (
        <section className="mt-10">
          <h2 className="mb-3 text-xl font-bold">Browse all</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {feed.genres.map((g, i) => (
              <Link key={g.id} href={`/music/genre/${g.id}`} data-card data-focusable className="relative aspect-[16/9] overflow-hidden rounded-lg p-3 text-lg font-bold" style={{ background: `hsl(${(i * 47) % 360} 55% 38%)` }}>
                {g.name}
                {g.pictureUrl && /* eslint-disable-next-line @next/next/no-img-element */ <img src={`/api/music/art?u=${encodeURIComponent(g.pictureUrl)}`} alt="" loading="lazy" className="absolute -bottom-3 -right-4 size-20 rotate-[25deg] rounded-md object-cover shadow-xl" />}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
