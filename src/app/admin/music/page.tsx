"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { CloudDownload, Disc3, FolderSearch, ImageDown, Trash2, Upload } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { api, Badge, Button, Card, ProgressBar, Skeleton } from "@/components/ui";
import { ErrorNote, PageHeader, ago } from "../parts";
import type { TrackDTO } from "@/lib/music-types";

interface Status {
  library: { tracks: number; albums: number; artists: number; missing: number; bytes: number; durationSec: number };
  scan: { running: boolean; finishedAt: string | null; progress: { dir: string; seen: number; indexed: number; skipped: number; failed: number } | null; last: { seen: number; added: number; failed: number; missing: number; errors: string[] } | null };
  worker: { ok: true; engine: string; cacheDir: string; cacheBytes: number; maxCacheBytes: number; entries: number; tracks: { key: string; title: string; artist: string; state: string; bytes: number; roles: string[]; sourceId?: string }[]; jobsRunning: number; jobsQueued: number; listeners: number; ytdlp: { available: boolean; version?: string }; lavalink: { nodes: { id: string; name: string; online: boolean; players?: number; version?: string; error?: string }[]; sinkReady: boolean; sinkEndpoint?: string } } | { ok: false; error: string };
}
const gb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export default function AdminMusicPage() {
  const status = usePoll<Status>("/api/admin/music/status", 3000);
  const recent = usePoll<{ tracks: TrackDTO[]; total: number }>("/api/music/library?kind=tracks&recent=true&take=15");
  const [uploads, setUploads] = useState<{ name: string; pct: number; error?: string; done?: boolean }[]>([]);
  const [msg, setMsg] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const s = status.data;

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    setUploads(list.map((f) => ({ name: f.name, pct: 0 })));
    for (let i = 0; i < list.length; i++) {
      await new Promise<void>((resolve) => {
        const x = new XMLHttpRequest();
        x.open("PUT", `/api/admin/music/upload?filename=${encodeURIComponent(list[i].name)}`);
        x.upload.onprogress = (e) => e.lengthComputable && setUploads((u) => u.map((r, j) => (j === i ? { ...r, pct: e.loaded / e.total } : r)));
        x.onload = () => { const err = x.status >= 400 ? (JSON.parse(x.responseText || "{}").error ?? `HTTP ${x.status}`) : undefined; setUploads((u) => u.map((r, j) => (j === i ? { ...r, pct: 1, done: !err, error: err } : r))); resolve(); };
        x.onerror = () => { setUploads((u) => u.map((r, j) => (j === i ? { ...r, error: "Network error" } : r))); resolve(); };
        x.send(list[i]);
      });
    }
    status.reload(); recent.reload();
  }
  const [artBusy, setArtBusy] = useState(false);
  async function fetchArt() {
    setArtBusy(true); setMsg("");
    try { const r = await api<{ result: { albums: number; found: number; tracks: number } }>("/api/admin/music/artwork", { method: "POST" }); setMsg(r.result.albums ? `Album art: found covers for ${r.result.found} of ${r.result.albums} albums (${r.result.tracks} songs).` : "Every song already has a cover, or online lookup is switched off."); status.reload(); }
    catch (e) { setMsg((e as Error).message); }
    setArtBusy(false);
  }
  async function scan() { setMsg(""); try { await api("/api/admin/music/scan", { method: "POST" }); status.reload(); } catch (e) { setMsg((e as Error).message); } }
  async function clearCache() { try { const r = await api<{ removed: number }>("/api/admin/music/cache", { method: "DELETE" }); setMsg(`Removed ${r.removed} cached track(s).`); status.reload(); } catch (e) { setMsg((e as Error).message); } }
  async function del(t: TrackDTO) { if (!confirm(`Remove “${t.title}” from the library? (The file is kept unless you uploaded it.)`)) return; await api(`/api/admin/music/tracks/${t.id}?file=1`, { method: "DELETE" }); recent.reload(); status.reload(); }

  if (status.loading || !s) return <><PageHeader title="Music" /><Skeleton className="h-96" /></>;
  const w = s.worker;
  return (
    <>
      <PageHeader title="Music" subtitle="Local library, upload, and the on-demand streaming backend." actions={<><Link href="/admin/music/settings"><Button variant="secondary">Settings</Button></Link><Button variant="secondary" onClick={fetchArt} loading={artBusy}><ImageDown className="size-4" /> Fetch missing album art</Button><Button onClick={scan} loading={s.scan.running}><FolderSearch className="size-4" /> Scan folders</Button></>} />
      <ErrorNote msg={msg} />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[["Tracks", s.library.tracks], ["Albums", s.library.albums], ["Artists", s.library.artists], ["Library size", gb(s.library.bytes)]].map(([k, v]) => <Card key={k as string}><p className="text-xs uppercase tracking-wide text-muted">{k}</p><p className="mt-1 text-2xl font-bold">{v}</p></Card>)}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="space-y-4">
          <h2 className="flex items-center gap-2 font-semibold"><Upload className="size-4" /> Upload music</h2>
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void uploadFiles(e.dataTransfer.files); }} className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <Disc3 className="size-8 text-white/30" />
            <p className="text-sm text-muted">Drop MP3, FLAC, AAC/M4A, OGG, WAV or Opus files here</p>
            <Button variant="secondary" onClick={() => input.current?.click()}>Choose files</Button>
            <input ref={input} type="file" multiple accept=".mp3,.flac,.aac,.m4a,.ogg,.oga,.opus,.wav,.aif,.aiff,.wma,audio/*" hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
          </div>
          {uploads.map((u, i) => <div key={i} className="text-sm"><div className="flex justify-between gap-2"><span className="truncate">{u.name}</span><span className={u.error ? "text-red-300" : u.done ? "text-emerald-300" : "text-muted"}>{u.error ?? (u.done ? "Added" : `${Math.round(u.pct * 100)}%`)}</span></div>{!u.done && !u.error && <ProgressBar value={u.pct} className="mt-1" />}</div>)}
          <p className="text-xs text-muted">Tags, cover art, artists, albums and genres are read automatically. Uploaded music stays until you delete it. Existing folders are indexed by &ldquo;Scan folders&rdquo; (also automatic every 10 minutes).</p>
          {s.scan.running && s.scan.progress && <p className="text-sm text-violet-300">Scanning {s.scan.progress.dir}: {s.scan.progress.seen} files ({s.scan.progress.indexed} new, {s.scan.progress.failed} failed)…</p>}
          {!s.scan.running && s.scan.last && <p className="text-xs text-muted">Last scan {ago(s.scan.finishedAt)}: {s.scan.last.seen} files, {s.scan.last.added} added, {s.scan.last.missing} missing, {s.scan.last.failed} unreadable.{s.scan.last.errors.length > 0 && <span className="block text-amber-300">{s.scan.last.errors.slice(0, 3).join(" · ")}</span>}</p>}
        </Card>

        <Card className="space-y-3">
          <h2 className="flex items-center gap-2 font-semibold"><CloudDownload className="size-4" /> On-demand backend</h2>
          {!w.ok ? <p className="text-sm text-amber-300">Worker unreachable: {w.error}</p> : (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge tone="accent">engine: {w.engine === "lavalink" ? "Lavalink" : w.engine === "auto" ? "Lavalink → yt-dlp" : "yt-dlp"}</Badge>
                <Badge tone={w.ytdlp.available ? "green" : "amber"}>yt-dlp {w.ytdlp.available ? w.ytdlp.version : "not installed"}</Badge>
                <Badge tone={w.lavalink.sinkReady ? "green" : "amber"}>audio bridge {w.lavalink.sinkReady ? "ready" : "off"}</Badge>
              </div>
              {w.lavalink.nodes.length > 0 && <ul className="space-y-1 text-sm">{w.lavalink.nodes.map((n) => <li key={n.id} className="flex items-center justify-between gap-2"><span className="truncate">{n.name}</span><span className="flex items-center gap-2 text-xs text-muted">{n.version && `v${n.version}`}{n.online ? <Badge tone="green">online{n.players ? ` · ${n.players} playing` : ""}</Badge> : <Badge tone="red" className="max-w-52 truncate">{n.error ?? "offline"}</Badge>}</span></li>)}</ul>}
              <div><div className="mb-1 flex justify-between text-xs text-muted"><span>Cache {gb(w.cacheBytes)} / {gb(w.maxCacheBytes)}</span><span>{w.entries} tracks · {w.listeners} listening · {w.jobsRunning} fetching{w.jobsQueued ? ` · ${w.jobsQueued} queued` : ""}</span></div><ProgressBar value={w.maxCacheBytes ? w.cacheBytes / w.maxCacheBytes : 0} /></div>
              <p className="truncate text-xs text-muted">{w.cacheDir}</p>
              {w.tracks.length > 0 && <ul className="space-y-1 text-xs">{w.tracks.map((t) => <li key={t.key} className="flex items-center justify-between gap-2"><span className="truncate">{t.title} <span className="text-muted">· {t.artist}</span></span><span className="flex shrink-0 items-center gap-1.5">{t.roles.map((r) => <Badge key={r} tone={r === "current" ? "green" : "accent"}>{r}</Badge>)}<Badge tone={t.state === "ready" ? "default" : t.state === "failed" ? "red" : "amber"}>{t.state}</Badge></span></li>)}</ul>}
              <Button variant="secondary" size="sm" onClick={clearCache}><Trash2 className="size-4" /> Clear unused cache</Button>
            </>
          )}
        </Card>

        <Card className="space-y-2 xl:col-span-2">
          <h2 className="font-semibold">Recently added</h2>
          {recent.data?.tracks.length ? recent.data.tracks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 border-b border-line/60 py-1.5 text-sm last:border-0">
              <span className="min-w-0 flex-1 truncate">{t.title} <span className="text-muted">· {t.artist}{t.album ? ` · ${t.album}` : ""}</span></span>
              <Badge>{t.codec}</Badge>
              <button aria-label={`Remove ${t.title}`} onClick={() => del(t)} className="-m-2 p-2 text-white/40 hover:text-red-300"><Trash2 className="size-4" /></button>
            </div>
          )) : <p className="text-sm text-muted">Nothing yet.</p>}
        </Card>
      </div>
    </>
  );
}
