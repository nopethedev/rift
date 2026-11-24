"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { BadgeCheck, ChevronDown, ExternalLink, Info, Music2, PanelLeftClose, PanelLeftOpen, Play, Shuffle, Users } from "lucide-react";
import { api, Button, Skeleton } from "@/components/ui";
import { AlbumCard, Cover, SectionTitle, TrackRow, trackRow, type RowItem } from "@/components/music/parts";
import { CatAlbumCard, CatArtistCard, ShelfRow } from "@/components/music/cards";
import { useMusic } from "@/components/music/player-provider";
import { artSrc, catInput, fmtCount, type AlbumDTO, type ArtistProfile, type CatTrack, type TrackDTO } from "@/lib/music-types";

type Disco = "all" | "album" | "single";

/** Accordion block in the info panel. */
function Fold({ title, icon: Icon, open: initial = false, children }: { title: string; icon: typeof Info; open?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="border-t border-white/10 first:border-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 py-3 text-left text-sm font-semibold"><Icon className="size-4 text-violet-300" />{title}<ChevronDown className={clsx("ml-auto size-4 text-muted transition", open && "rotate-180")} /></button>
      {open && <div className="pb-4 text-sm">{children}</div>}
    </section>
  );
}

function About({ text, url }: { text: string; url: string | null }) {
  const [more, setMore] = useState(false);
  return (
    <>
      <p className={clsx("whitespace-pre-line leading-relaxed text-white/80", !more && "line-clamp-6")}>{text}</p>
      <div className="mt-2 flex items-center gap-3">
        {text.length > 280 && <button onClick={() => setMore((m) => !m)} className="py-2 text-xs font-semibold text-violet-300 hover:underline">{more ? "Show less" : "Show more"}</button>}
        {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 py-2 text-xs text-muted hover:text-white">Wikipedia <ExternalLink className="size-3" /></a>}
      </div>
    </>
  );
}

export function ArtistView({ name, id }: { name: string; id?: string }) {
  const [online, setOnline] = useState<{ state: "loading" | "ready" | "none" | "error"; profile?: ArtistProfile; error?: string }>({ state: "loading" });
  const [local, setLocal] = useState<{ tracks: TrackDTO[]; total: number; albums: AlbumDTO[] } | null>(null);
  const [panel, setPanel] = useState(true);
  const [disco, setDisco] = useState<Disco>("all");
  const [topShown, setTopShown] = useState<5 | 10 | "all">(5); // like Spotify: 5, then 10, then every song we know
  const { playItems, current, play } = useMusic();

  useEffect(() => { try { setPanel(localStorage.getItem("rift-artist-panel") !== "0"); } catch { /* storage blocked */ } }, []);
  const togglePanel = () => setPanel((p) => { try { localStorage.setItem("rift-artist-panel", p ? "0" : "1"); } catch { /* ignore */ } return !p; });

  useEffect(() => {
    let live = true;
    const q = new URLSearchParams(id ? { id } : { name });
    api<{ profile: ArtistProfile | null }>(`/api/music/online/artist?${q}`).then((r) => live && setOnline(r.profile ? { state: "ready", profile: r.profile } : { state: "none" })).catch((e: Error) => live && setOnline({ state: /turned off/.test(e.message) ? "none" : "error", error: e.message }));
    return () => { live = false; };
  }, [name, id]);
  useEffect(() => {
    Promise.all([
      api<{ tracks: TrackDTO[]; total: number }>(`/api/music/library?kind=tracks&artist=${encodeURIComponent(name)}&take=200`),
      api<{ albums: AlbumDTO[] }>(`/api/music/library?kind=albums&artist=${encodeURIComponent(name)}`),
    ]).then(([t, a]) => setLocal({ tracks: t.tracks, total: t.total, albums: a.albums })).catch(() => setLocal({ tracks: [], total: 0, albums: [] }));
  }, [name]);

  const p = online.profile;
  const displayName = p?.artist.name ?? name;
  const photo = p?.artist.pictureUrl ?? local?.tracks.find((t) => t.coverUrl)?.coverUrl ?? null;
  const top = p?.topTracks ?? [];
  const localInputs = (local?.tracks ?? []).map((t) => ({ trackId: t.id }));
  const playAll = (shuffle: boolean) => (top.length ? playItems(top.map(catInput), { startIndex: 0, shuffle }) : playItems(localInputs, { startIndex: 0, shuffle }));
  const albums = (p?.albums ?? []).filter((a) => (disco === "all" ? true : disco === "album" ? a.kind === "album" || a.kind === null : a.kind === "single" || a.kind === "ep"));
  const topRow = (t: CatTrack): RowItem => ({ key: t.id, input: catInput(t), title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec, cover: t.artworkUrl });
  const isActive = (t: { title: string; artist: string }) => !!current && !!play && current.title === t.title;
  const ready = online.state !== "loading" && local;

  return (
    <div className="md:flex md:items-start md:gap-6">
      {/* ---- info panel (left, collapsible; sections expand) ---- */}
      <aside aria-label={`About ${displayName}`} className={clsx("mb-6 shrink-0 md:sticky md:top-20 md:mb-0 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto md:rounded-xl md:bg-black/25 md:transition-[width]", panel ? "md:w-80" : "md:w-14")}>
        <div className={clsx("flex items-center", panel ? "justify-between px-4 pt-3" : "justify-center py-3")}>
          {panel && <span className="text-xs font-semibold uppercase tracking-wide text-muted">Artist info</span>}
          <button onClick={togglePanel} aria-expanded={panel} aria-label={panel ? "Collapse artist info" : "Expand artist info"} title={panel ? "Collapse" : "Expand"} className="hidden rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white md:block">{panel ? <PanelLeftClose className="size-5" /> : <PanelLeftOpen className="size-5" />}</button>
        </div>
        {!panel && <div className="hidden flex-col items-center gap-3 pb-4 md:flex"><Cover src={photo} className="size-10" rounded="rounded-full" /></div>}
        <div className={clsx("px-4 pb-4", !panel && "md:hidden")}>
          <Cover src={photo} className="mx-auto mt-2 aspect-square w-full max-w-64 md:max-w-none" rounded="rounded-2xl" />
          <h2 className="mt-3 flex items-center gap-1.5 text-xl font-bold">{displayName}{p && <BadgeCheck className="size-4 shrink-0 text-violet-300" aria-label="Matched artist" />}</h2>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {p?.artist.fans != null && <div><dt className="sr-only">Fans</dt><dd><b className="text-white">{fmtCount(p.artist.fans)}</b> fans</dd></div>}
            {p?.artist.albums != null && <div><dd><b className="text-white">{p.artist.albums}</b> releases</dd></div>}
            {local && local.total > 0 && <div><dd><b className="text-white">{local.total}</b> in your library</dd></div>}
          </dl>
          <div className="mt-3">
            {online.state === "loading" && <Skeleton className="h-24" />}
            <Fold title="About" icon={Info} open>
              {p?.bio ? <About text={p.bio.text} url={p.bio.url} /> : <p className="text-muted">{online.state === "error" ? online.error : online.state === "ready" ? "No biography found for this artist." : "No online info for this artist."}</p>}
            </Fold>
            {!!p?.related.length && (
              <Fold title="Similar artists" icon={Users}>
                <ul className="space-y-1">{p.related.slice(0, 8).map((r) => <li key={r.id}><Link href={`/music/artists/${encodeURIComponent(r.name)}?id=${r.id}`} className="flex items-center gap-3 rounded-lg p-1.5 hover:bg-white/10"><Cover src={r.pictureUrl} className="size-9" rounded="rounded-full" /><span className="truncate">{r.name}</span><span className="ml-auto text-[11px] text-muted">{fmtCount(r.fans)}</span></Link></li>)}</ul>
              </Fold>
            )}
            {!!local?.albums.length && <Fold title={`In your library (${local.total})`} icon={Music2}><ul className="space-y-1">{local.albums.slice(0, 8).map((a) => <li key={a.albumKey}><Link href={`/music/albums/${a.albumKey}`} className="flex items-center gap-3 rounded-lg p-1.5 hover:bg-white/10"><Cover src={a.coverUrl} className="size-9" /><span className="truncate">{a.album}</span><span className="ml-auto text-[11px] text-muted">{a.tracks}</span></Link></li>)}</ul></Fold>}
          </div>
        </div>
      </aside>

      {/* ---- main column ---- */}
      <div className="min-w-0 flex-1">
        <div className="relative mb-6 overflow-hidden rounded-2xl">
          {photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={artSrc(photo) ?? undefined} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover opacity-30 blur-2xl" />}
          <div className="relative bg-gradient-to-t from-bg/70 to-transparent p-5 pt-16 sm:p-8 sm:pt-24">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/70">Artist</p>
            <h1 className="mt-1 break-words text-4xl font-extrabold sm:text-6xl">{displayName}</h1>
            <p className="mt-2 text-sm text-white/80">{[p?.artist.fans != null ? `${fmtCount(p.artist.fans)} fans` : null, local?.total ? `${local.total} songs in your library` : null].filter(Boolean).join(" · ")}</p>
            <div className="mt-5 flex gap-2">
              <Button disabled={!ready || (!top.length && !localInputs.length)} onClick={() => playAll(false)}><Play className="size-4 fill-current" /> Play</Button>
              <Button variant="secondary" disabled={!ready || (!top.length && !localInputs.length)} onClick={() => playAll(true)}><Shuffle className="size-4" /> Shuffle</Button>
            </div>
          </div>
        </div>

        {online.state === "error" && <p role="status" className="mb-4 rounded-lg bg-white/5 px-3 py-2 text-sm text-muted">Couldn&apos;t load online info: {online.error}</p>}

        {!!top.length && (
          <section className="mt-6">
            <SectionTitle>Popular</SectionTitle>
            {top.slice(0, topShown === "all" ? top.length : topShown).map((t, i) => <TrackRow key={t.id} item={topRow(t)} index={i} active={isActive(t)} onPlay={() => playItems(top.map(catInput), { startIndex: i, shuffle: false })} />)}
            {top.length > 5 && (
              <div className="mt-2 flex gap-4 px-3">
                {topShown === 5 && <button onClick={() => setTopShown(top.length > 10 ? 10 : "all")} className="py-2 text-sm font-semibold text-white/70 hover:text-white">See more</button>}
                {topShown === 10 && top.length > 10 && <button onClick={() => setTopShown("all")} className="py-2 text-sm font-semibold text-white/70 hover:text-white">Show all {top.length} songs</button>}
                {topShown !== 5 && <button onClick={() => setTopShown(5)} className="py-2 text-sm font-semibold text-white/70 hover:text-white">Show less</button>}
              </div>
            )}
          </section>
        )}

        {!!local?.tracks.length && (
          <section className="mt-6">
            <SectionTitle>In your library</SectionTitle>
            {local.tracks.slice(0, 10).map((t, i) => <TrackRow key={t.id} item={trackRow(t)} index={i} active={current?.trackId === t.id && play?.kind === "local"} onPlay={() => playItems(localInputs, { startIndex: i, shuffle: false })} />)}
            {local.total > 10 && <p className="mt-2 px-3 text-xs text-muted">{local.total - 10} more in Your Library → Artists.</p>}
          </section>
        )}

        {!!p && (!!p.albums.length || !!p.albumsError || !!p.artist.albums) && (
          <section className="mt-6">
            <SectionTitle action={
              <div className="flex gap-1 rounded-full bg-white/5 p-1" role="tablist">{([["all", "All"], ["album", "Albums"], ["single", "Singles & EPs"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={disco === k} onClick={() => setDisco(k)} className={clsx("rounded-full px-3 py-2 text-xs font-medium pointer-fine:py-1", disco === k ? "bg-white text-black" : "text-white/70 hover:text-white")}>{l}</button>)}</div>
            }>Discography</SectionTitle>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{albums.map((a) => <CatAlbumCard key={a.id} a={a} />)}</div>
            {!albums.length && <p className="text-sm text-muted">{p.albumsError ? `Couldn't load the releases (${p.albumsError}). Reload the page to try again.` : p.albums.length ? "Nothing in this category." : "No releases found for this artist."}</p>}
          </section>
        )}

        {!!p?.related.length && <div className="mt-8"><ShelfRow title="Fans also like">{p.related.map((r) => <CatArtistCard key={r.id} a={r} />)}</ShelfRow></div>}

        {ready && !top.length && !local?.tracks.length && online.state !== "error" && <p className="rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">Nothing to show for “{name}” yet.</p>}
        {!ready && <Skeleton className="h-64" />}
        {local && !!local.albums.length && !p && <><SectionTitle>Albums</SectionTitle><div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">{local.albums.map((a) => <AlbumCard key={a.albumKey} a={a} />)}</div></>}
      </div>
    </div>
  );
}
