"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ListMusic, Plus } from "lucide-react";
import { api, Button, Input, Skeleton } from "@/components/ui";
import { Modal, ErrorNote } from "@/app/admin/parts";
import { usePoll } from "@/lib/use-poll";
import { Cover, Empty } from "@/components/music/parts";
import { SpotifyImporter } from "@/components/music/spotify-import";

interface PL { id: string; name: string; source: string; count: number; unavailable: number; artworkUrl: string | null }

export function PlaylistsView() {
  const router = useRouter();
  const { data, loading, reload } = usePoll<{ playlists: PL[] }>("/api/music/playlists");
  const [open, setOpen] = useState<"new" | "spotify" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function create() {
    setBusy(true); setErr("");
    try { const r = await api<{ id: string }>("/api/music/playlists", { method: "POST", body: { name } }); router.push(`/music/playlists/${r.id}`); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">Playlists</h1><div className="flex gap-2"><Button variant="secondary" onClick={() => { setErr(""); setOpen("spotify"); }}>Import from Spotify</Button><Button onClick={() => { setErr(""); setOpen("new"); }}><Plus className="size-4" /> New playlist</Button></div></div>
      {loading ? <Skeleton className="h-40" /> : data?.playlists.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {data.playlists.map((p) => (
            <Link key={p.id} href={`/music/playlists/${p.id}`} data-card data-focusable className="group block min-w-0">
              <Cover src={p.artworkUrl} className="aspect-square w-full" rounded="rounded-xl" />
              <p className="mt-2 truncate text-sm font-semibold">{p.name}</p>
              <p className="flex items-center gap-1.5 truncate text-xs text-muted">{p.count} tracks{p.source === "spotify" ? " · Spotify" : ""}{p.unavailable > 0 && <span className="inline-flex items-center gap-0.5 text-amber-300"><AlertCircle className="size-3" />{p.unavailable}</span>}</p>
            </Link>
          ))}
        </div>
      ) : <Empty icon={ListMusic} title="No playlists yet">Create one, add songs from any track menu, or paste a Spotify playlist link to import it.</Empty>}
      <Modal open={open === "new"} onClose={() => setOpen(null)} title="New playlist"><div className="space-y-3"><Input aria-label="Playlist name" autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} /><ErrorNote msg={err} /><Button onClick={create} loading={busy} disabled={!name.trim()}>Create</Button></div></Modal>
      <Modal open={open === "spotify"} onClose={() => setOpen(null)} title="Import from Spotify">
        <p className="mb-3 text-sm text-muted">Paste playlist or album links (or a profile link). Rift copies the song list and plays each song from your library or an on-demand source.</p>
        <SpotifyImporter onImported={() => reload()} />
      </Modal>
    </div>
  );
}
