"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, CloudDownload, HardDrive, Loader2, Play, RefreshCw, Shuffle, Trash2, X } from "lucide-react";
import { api, Button, Skeleton } from "@/components/ui";
import { ErrorNote } from "@/app/admin/parts";
import { usePoll } from "@/lib/use-poll";
import { Cover, TrackRow, type RowItem } from "@/components/music/parts";
import { useMusic } from "@/components/music/player-provider";
import type { TrackDTO } from "@/lib/music-types";

interface Item { id: string; title: string; artist: string; album: string | null; durationSec: number | null; artworkUrl: string | null; trackId: string | null; availability: "local" | "ondemand" | "unavailable" | null; availabilityNote: string | null; track: TrackDTO | null }
interface Resp { playlist: { id: string; name: string; description: string | null; source: string; sourceUrl: string | null; artworkUrl: string | null; lastSyncedAt: string | null; count: number; unavailable: number }; items: Item[]; check: { running: boolean; done: number; total: number } | null }

export default function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [poll, setPoll] = useState(0);
  const { data, loading, error, reload } = usePoll<Resp>(`/api/music/playlists/${id}`, poll);
  const { playPlaylist, current, play } = useMusic();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<"sync" | "check" | null>(null);
  const checking = !!data?.check?.running;
  useEffect(() => { setPoll(checking ? 1500 : 0); }, [checking]);

  if (loading) return <Skeleton className="h-64" />;
  if (error || !data) return <p role="alert" className="text-red-300">{error || "Playlist not found"}</p>;
  const { playlist: p, items } = data;
  const act = async (kind: "sync" | "check") => {
    setBusy(kind); setMsg("");
    try {
      if (kind === "sync") { const r = await api<{ imported: number; truncated: boolean; via: string }>(`/api/music/playlists/${id}/sync`, { method: "POST" }); setMsg(`Synchronised ${r.imported} tracks${r.truncated ? " (Spotify's keyless page shows only the first 100: add a Spotify client id/secret in Admin → Music for full playlists)" : ""}.`); }
      else await api(`/api/music/playlists/${id}/check`, { method: "POST" });
      reload(); setPoll(1500);
    } catch (e) { setMsg((e as Error).message); }
    setBusy(null);
  };
  const rowOf = (it: Item): RowItem => ({
    key: it.id, title: it.title, artist: it.artist, album: it.album, durationSec: it.durationSec, cover: it.artworkUrl ?? it.track?.coverUrl ?? null, trackId: it.trackId ?? undefined,
    input: it.trackId ? { trackId: it.trackId } : { title: it.title, artist: it.artist, album: it.album, durationSec: it.durationSec, artworkUrl: it.artworkUrl },
    unavailable: it.availability === "unavailable" ? (it.availabilityNote ?? "Unavailable") : undefined,
  });
  const badge = (it: Item) => it.availability === "local" ? <span title="In your library" className="hidden text-emerald-300 sm:block"><HardDrive className="size-3.5" /></span>
    : it.availability === "ondemand" ? <span title="Found on an authorised on-demand source" className="hidden text-violet-300 sm:block"><CloudDownload className="size-3.5" /></span>
    : it.availability === "unavailable" ? <span title={it.availabilityNote ?? "Unavailable"} className="text-amber-300"><AlertCircle className="size-3.5" /></span>
    : <span title="Not checked yet" className="hidden text-white/30 sm:block"><Loader2 className="size-3.5" /></span>;
  const playable = items.filter((i) => i.availability !== "unavailable").length;
  return (
    <div>
      <div className="mb-5 flex flex-col gap-5 sm:flex-row sm:items-end">
        <Cover src={p.artworkUrl} className="aspect-square w-44 sm:w-52" rounded="rounded-2xl" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{p.source === "spotify" ? "Imported from Spotify" : "Playlist"}</p>
          <h1 className="truncate text-3xl font-bold sm:text-4xl">{p.name}</h1>
          <p className="mt-1 text-sm text-white/80">{p.count} tracks · {playable} playable{p.unavailable ? ` · ${p.unavailable} unavailable` : ""}{p.lastSyncedAt ? ` · synced ${new Date(p.lastSyncedAt).toLocaleDateString()}` : ""}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => playPlaylist(id)} disabled={!playable}><Play className="size-4 fill-current" /> Play</Button>
            <Button variant="secondary" onClick={() => playPlaylist(id, { shuffle: true })} disabled={!playable}><Shuffle className="size-4" /> Shuffle</Button>
            {p.source === "spotify" && <Button variant="secondary" loading={busy === "sync"} onClick={() => act("sync")}><RefreshCw className="size-4" /> Sync</Button>}
            <Button variant="secondary" loading={busy === "check" || checking} onClick={() => act("check")}><CheckCircle2 className="size-4" /> {checking ? `Checking ${data.check!.done}/${data.check!.total}` : "Check sources"}</Button>
            <Button variant="ghost" onClick={async () => { if (confirm(`Delete “${p.name}”?`)) { await api(`/api/music/playlists/${id}`, { method: "DELETE" }); router.replace("/music/playlists"); } }} aria-label="Delete playlist"><Trash2 className="size-4" /></Button>
          </div>
        </div>
      </div>
      <ErrorNote msg={msg && /fail|error|private|couldn|not/i.test(msg) ? msg : ""} />
      {msg && !/fail|error|private|couldn|not/i.test(msg) && <p className="mb-3 text-sm text-emerald-300">{msg}</p>}
      {items.map((it, i) => (
        <div key={it.id} className="flex items-center gap-1">
          <div className="min-w-0 flex-1"><TrackRow item={rowOf(it)} index={i} extra={badge(it)} active={!!current && ((it.trackId && current.trackId === it.trackId) || (current.title === it.title && current.artist === it.artist)) && !!play} onPlay={() => playPlaylist(id, { startItemId: it.id })} /></div>
          <button aria-label={`Remove ${it.title}`} onClick={async () => { await api(`/api/music/playlists/${id}/items`, { method: "DELETE", body: { itemId: it.id } }); reload(); }} className="rounded-md p-1.5 text-white/40 hover:text-red-300"><X className="size-4" /></button>
        </div>
      ))}
      {!items.length && <p className="py-10 text-center text-muted">This playlist is empty. Add songs from any track&apos;s menu.</p>}
    </div>
  );
}
