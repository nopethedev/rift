"use client";
import { useRef, useState } from "react";
import { ChevronDown, FileDown, Link2, Pause, Play, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { fmtBytes } from "@/lib/types";
import { Badge, Button, Card, Input, ProgressBar, Skeleton, api } from "@/components/ui";
import { ErrorNote, Modal, PageHeader } from "../parts";
import { FileSelector, type Preview, defaultSelection, fmtEta, fmtSpeed } from "../torrent-parts";

interface D {
  id: string; infoHash: string; name: string; status: string; progress: number; size: number; downloaded: number; downloadSpeed: number; uploadSpeed: number;
  peers: number; ratio: number; eta: number | null; error?: string | null; savePath: string; mediaType?: string | null; tmdbId?: number | null;
  files: { index: number; path: string; size: number; selected: boolean; progress: number }[];
}

const TONE: Record<string, "green" | "accent" | "amber" | "red" | "default"> = { downloading: "accent", completed: "green", imported: "green", seeding: "green", paused: "amber", error: "red", metadata: "amber", queued: "default", importing: "accent" };

export default function DownloadsPage() {
  const { data, loading, reload } = usePoll<{ downloads: D[] }>("/api/admin/downloads", 2000);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await reload(); } catch (e) { setErr((e as Error).message); } };

  const totals = data?.downloads.reduce((a, d) => ({ down: a.down + d.downloadSpeed, up: a.up + d.uploadSpeed }), { down: 0, up: 0 });
  return (
    <>
      <PageHeader title="Downloads" subtitle={totals ? `↓ ${fmtSpeed(totals.down)}  ↑ ${fmtSpeed(totals.up)}` : "WebTorrent download manager"} actions={<Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add torrent</Button>} />
      <p className="-mt-3 mb-5 text-xs text-muted">Only add content you own or are licensed to download. Nothing is ever downloaded automatically.</p>
      <ErrorNote msg={err} />
      <div className="mt-3 space-y-3">
        {loading && <Skeleton className="h-28" />}
        {data?.downloads.map((d) => <DownloadCard key={d.id} d={d} act={act} />)}
        {data && !data.downloads.length && <Card className="py-14 text-center text-muted">No downloads. Add a magnet link or .torrent file — or use <span className="text-violet-300">Add media</span> to search.</Card>}
      </div>
      <AddTorrent open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload(); }} />
    </>
  );
}

function DownloadCard({ d, act }: { d: D; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const active = ["downloading", "metadata", "queued"].includes(d.status);
  const patch = (body: object) => act(() => api(`/api/admin/downloads/${d.id}`, { method: "PATCH", body }));
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={d.name}>{d.name}</p>
          <p className="mt-0.5 text-xs text-muted">{fmtBytes(d.downloaded)} / {fmtBytes(d.size)}{d.mediaType ? ` · linked to ${d.mediaType === "tv" ? "TV show" : "movie"}` : ""}</p>
        </div>
        <Badge tone={TONE[d.status] ?? "default"}>{d.status}</Badge>
        <div className="flex gap-1">
          {active || d.status === "importing" ? (
            <Button size="sm" variant="secondary" onClick={() => patch({ action: "pause" })} title="Pause"><Pause className="size-4" /></Button>
          ) : d.status === "paused" || d.status === "error" ? (
            <Button size="sm" variant="secondary" onClick={() => patch({ action: "resume" })} title="Resume"><Play className="size-4" /></Button>
          ) : null}
          {(d.status === "completed" || d.status === "imported" || d.status === "error") && d.progress > 0 && (
            <Button size="sm" variant="secondary" onClick={() => patch({ action: "import" })} title="Scan & match files now"><RefreshCw className="size-4" /></Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} title="Files"><ChevronDown className={`size-4 transition ${open ? "rotate-180" : ""}`} /></Button>
          <Button size="sm" variant="ghost" className="text-red-300" title="Remove" onClick={() => {
            if (!confirm(`Remove "${d.name}"?`)) return;
            const del = d.progress > 0 && confirm("Also delete the downloaded files from disk?\n\nOK = delete files, Cancel = keep files");
            act(() => api(`/api/admin/downloads/${d.id}?deleteFiles=${del ? 1 : 0}`, { method: "DELETE" }));
          }}><Trash2 className="size-4" /></Button>
        </div>
      </div>
      <ProgressBar value={d.progress} />
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>{(d.progress * 100).toFixed(1)}%</span>
        {active && <><span>↓ {fmtSpeed(d.downloadSpeed)}</span><span>ETA {fmtEta(d.eta)}</span></>}
        <span>↑ {fmtSpeed(d.uploadSpeed)}</span><span>{d.peers} peers</span><span>ratio {d.ratio.toFixed(2)}</span>
      </div>
      {d.error && <ErrorNote msg={d.error} />}
      {open && (
        <div className="space-y-2 border-t border-line pt-3">
          <FileSelector
            files={d.files.map((f) => ({ index: f.index, path: f.path, size: f.size }))}
            selected={sel ?? new Set(d.files.filter((f) => f.selected).map((f) => f.index))}
            onChange={setSel}
          />
          {sel && <Button size="sm" onClick={() => patch({ action: "files", selectedFiles: [...sel] }).then(() => setSel(null))}>Apply file selection</Button>}
          <p className="text-xs text-muted">Saved to {d.savePath}</p>
        </div>
      )}
    </Card>
  );
}

function AddTorrent({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [magnet, setMagnet] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const body = () => {
    if (file) { const f = new FormData(); f.set("file", file); return { body: f } as const; }
    return { body: JSON.stringify({ magnet: magnet.trim() }), headers: { "content-type": "application/json" } } as const;
  };
  const reset = () => { setPreview(null); setMagnet(""); setFile(null); setErr(""); setSel(new Set()); };

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/admin/downloads/preview", { method: "POST", ...body() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setPreview(j.preview); setSel(defaultSelection(j.preview.files));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  async function add() {
    if (!preview) return;
    setBusy(true); setErr("");
    try {
      let r: Response;
      if (file) { const f = new FormData(); f.set("file", file); f.set("selectedFiles", JSON.stringify([...sel])); r = await fetch("/api/admin/downloads", { method: "POST", body: f }); }
      else r = await fetch("/api/admin/downloads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ magnet: magnet.trim(), selectedFiles: [...sel] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      reset(); onAdded();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Add torrent" wide>
      {!preview ? (
        <div className="space-y-4">
          <Input label="Magnet link" value={magnet} onChange={(e) => { setMagnet(e.target.value); setFile(null); }} placeholder="magnet:?xt=urn:btih:…" />
          <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" /></div>
          <input ref={fileInput} type="file" accept=".torrent,application/x-bittorrent" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); setMagnet(""); }} />
          <button type="button" onClick={() => fileInput.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line px-4 py-6 text-sm text-muted transition hover:border-accent hover:text-white">
            {file ? <><FileDown className="size-5 text-accent" /> {file.name}</> : <><Upload className="size-5" /> Choose a .torrent file</>}
          </button>
          <ErrorNote msg={err} />
          <Button onClick={load} loading={busy} disabled={!magnet.trim() && !file} className="w-full"><Link2 className="size-4" /> Fetch file list</Button>
          <p className="text-xs text-muted">Metadata is fetched from peers (up to ~45 s) before anything is downloaded.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div><p className="font-semibold">{preview.name}</p><p className="text-xs text-muted">{fmtBytes(preview.totalSize)} · {preview.files.length} files</p></div>
          <FileSelector files={preview.files} selected={sel} onChange={setSel} />
          <ErrorNote msg={err} />
          <div className="flex justify-between"><Button variant="ghost" onClick={() => setPreview(null)}>Back</Button><Button onClick={add} loading={busy} disabled={!sel.size}>Start download</Button></div>
        </div>
      )}
    </Modal>
  );
}
