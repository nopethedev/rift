"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { BadgeCheck, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { api } from "../ui";
import { artSrc, fmtCount, fmtTime, type ArtistProfile } from "@/lib/music-types";
import { upcoming } from "@/lib/music-queue";
import { Cover, HeartButton } from "./parts";
import { useMusic } from "./player-provider";

// ---- open / closed, remembered per browser ----
const KEY = "rift-music-side-panel";
const listeners = new Set<() => void>();
const read = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };
const subscribe = (cb: () => void) => { listeners.add(cb); window.addEventListener("storage", cb); return () => { listeners.delete(cb); window.removeEventListener("storage", cb); }; };
function setPanelOpen(open: boolean) {
  try { localStorage.setItem(KEY, open ? "1" : "0"); } catch { /* storage blocked: stays in this tab only */ }
  listeners.forEach((l) => l());
}
export const useSidePanelOpen = () => useSyncExternalStore(subscribe, read, () => true);

/** True when the right-hand Now Playing panel is on screen (something is playing, the panel is open, and we're in Music). */
export function useSidePanelVisible() {
  const { current } = useMusic();
  const open = useSidePanelOpen();
  return !!current && open;
}

/** Player-bar button that shows / hides the panel (large screens, Music app only). */
export function SidePanelToggle({ className }: { className?: string }) {
  const open = useSidePanelOpen();
  const inMusic = usePathname().startsWith("/music");
  if (!inMusic) return null;
  const Icon = open ? PanelRightClose : PanelRightOpen;
  return <button aria-label="Now playing view" aria-pressed={open} title="Now playing view" onClick={() => setPanelOpen(!open)} className={clsx("hidden rounded-md p-2 hover:bg-white/10 lg:block", open ? "text-accent" : "text-white/70 hover:text-white", className)}><Icon className="size-5" /></button>;
}

/** Like / unlike whatever is playing now. */
export function CurrentHeart({ className }: { className?: string }) {
  const { current } = useMusic();
  if (!current) return null;
  const input = current.trackId ? { trackId: current.trackId } : { title: current.title, artist: current.artist, album: current.album, durationSec: current.durationSec, artworkUrl: current.artworkUrl };
  return <HeartButton item={{ input, title: current.title, artist: current.artist }} className={clsx("sm:!opacity-100", className)} />;
}

// ---- artist lookup (Deezer + Wikipedia via our own API), cached for the life of the page ----
const cache = new Map<string, ArtistProfile | null>();
const names = (artist: string) => {
  const first = artist.split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b)\s*/i)[0]?.trim();
  return first && first !== artist ? [artist, first] : [artist];
};
async function lookup(artist: string): Promise<ArtistProfile | null> {
  if (cache.has(artist)) return cache.get(artist)!;
  let found: ArtistProfile | null = null;
  for (const n of names(artist)) {
    const r = await api<{ profile: ArtistProfile | null }>(`/api/music/online/artist?name=${encodeURIComponent(n)}`);
    if (r.profile) { found = r.profile; break; }
  }
  cache.set(artist, found);
  return found;
}

/** `loading` while the lookup runs; `profile` is null when nothing (or the catalogue being off) means there's no card to enrich. */
export function useArtist(artist: string | undefined) {
  const [state, setState] = useState<{ artist: string; profile: ArtistProfile | null } | null>(null);
  useEffect(() => {
    if (!artist) return;
    let live = true;
    lookup(artist).then((profile) => live && setState({ artist, profile })).catch(() => live && setState({ artist, profile: null }));
    return () => { live = false; };
  }, [artist]);
  const done = !!artist && state?.artist === artist;
  return { loading: !!artist && !done, profile: done ? state.profile : null };
}

/** Spotify-style "About the artist" card: photo, fans, a short bio, link to the full artist page. */
export function ArtistCard({ artist, className }: { artist: string; className?: string }) {
  const { loading, profile } = useArtist(artist);
  const [more, setMore] = useState(false);
  const name = profile?.artist.name ?? artist;
  const href = `/music/artists/${encodeURIComponent(name)}${profile ? `?id=${profile.artist.id}` : ""}`;
  const photo = profile?.artist.pictureUrl ?? null;
  const bio = profile?.bio?.text ?? "";
  return (
    <section aria-label={`About ${name}`} className={clsx("overflow-hidden rounded-xl bg-surface-2", className)}>
      <Link href={href} className="relative block h-44 bg-gradient-to-br from-accent/40 via-surface-2 to-surface">
        {photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={artSrc(photo) ?? undefined} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />}
        <span className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-transparent" />
        <span className="absolute left-3 top-3 text-sm font-bold">About the artist</span>
      </Link>
      <div className="space-y-1.5 p-3">
        <Link href={href} className="flex items-center gap-1.5 font-bold hover:underline"><span className="truncate">{name}</span>{profile && <BadgeCheck className="size-4 shrink-0 text-violet-300" aria-label="Matched artist" />}</Link>
        {profile?.artist.fans != null && <p className="text-xs text-muted"><b className="text-white">{fmtCount(profile.artist.fans)}</b> fans</p>}
        {loading && <div className="skeleton h-16" aria-hidden />}
        {bio && (
          <>
            <p className={clsx("whitespace-pre-line break-words text-sm leading-relaxed text-white/75", !more && "line-clamp-4")}>{bio}</p>
            {bio.length > 220 && <button onClick={() => setMore((m) => !m)} className="py-1 text-xs font-semibold text-violet-300 hover:underline">{more ? "Show less" : "Show more"}</button>}
          </>
        )}
        {!loading && !bio && <p className="text-sm text-muted">No biography found.</p>}
      </div>
    </section>
  );
}

/** Right-hand "Now playing" column (Music app, large screens): the track, the artist card, what's next. No lyrics. */
export function NowPlayingPanel() {
  const { current, queue, playQueueItem } = useMusic();
  const visible = useSidePanelVisible();
  if (!current || !visible) return null;
  const next = queue ? upcoming(queue.items.map((i, position) => ({ id: i.id, position })), queue.state, 3).map((id) => queue.items.find((i) => i.id === id)!).filter(Boolean) : [];
  return (
    <aside aria-label="Now playing" data-testid="side-panel" className="fixed bottom-0 right-0 top-14 z-30 hidden w-80 flex-col p-2 pb-[5rem] pl-0 lg:flex">
      <div className="no-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="truncate text-sm font-bold">{current.album ?? "Now playing"}</h2>
          <button aria-label="Hide now playing view" onClick={() => setPanelOpen(false)} className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
        </div>
        <Cover src={current.artworkUrl} className="aspect-square w-full" rounded="rounded-xl" />
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words text-xl font-extrabold leading-tight">{current.title}</p>
            <p className="truncate text-sm text-muted">{current.artist}</p>
          </div>
          <CurrentHeart />
        </div>
        <ArtistCard artist={current.artist} />
        {!!next.length && (
          <section aria-label="Next in queue" className="rounded-xl bg-surface-2 p-3">
            <h3 className="mb-1 text-sm font-bold">Next in queue</h3>
            <ul>
              {next.map((it) => (
                <li key={it.id}>
                  <button onClick={() => playQueueItem(it.id)} aria-label={`Play ${it.title}`} className="flex w-full items-center gap-3 rounded-lg p-1.5 text-left hover:bg-white/10">
                    <Cover src={it.artworkUrl} className="size-10" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{it.title}</span><span className="block truncate text-xs text-muted">{it.artist}</span></span>
                    <span className="text-xs tabular-nums text-muted">{fmtTime(it.durationSec)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
