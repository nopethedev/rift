"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Captions, FileVideo, FolderSync, Link as LinkIcon, Plus, Search, Subtitles, Trash2, Upload } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { fmtBytes, fmtDuration, tmdbImg } from "@/lib/types";
import { Badge, Button, Card, Input, Select, Skeleton, api } from "@/components/ui";
import { SubtitleFinder } from "@/components/subtitle-finder";
import { ErrorNote, Modal, PageHeader } from "../parts";

interface T { id: string; type: string; tmdbId: number | null; title: string; year: number | null; posterPath: string | null; fileCount: number; episodeCount: number; sizeBytes: number; missing: number }
interface U { id: string; path: string; rawName: string | null; size: number; durationSec: number | null; source: string; createdAt: string }
interface Data { titles: T[]; unmatched: U[]; missing: number }
interface ScanStatus { running: boolean; progress: { done: number; total: number; current?: string } | null; lastReports: { imported: number; matched: number; unmatched: number; errors: unknown[] }[] }

export default function MediaPage() {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"library" | "unmatched">("library");
  const { data, loading, reload } = usePoll<Data>(`/api/admin/media?q=${encodeURIComponent(q)}`);
  const scan = usePoll<{ status: ScanStatus }>("/api/admin/media/scan", 2000);
  const [manage, setManage] = useState<string | null>(null);
  const [match, setMatch] = useState<U | null>(null);
  const running = scan.data?.status.running;

  useEffect(() => { if (running === false) reload(); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        title="Media"
        subtitle="Movies, shows, seasons, episodes and subtitles in your library."
        actions={<>
          <Button variant="secondary" loading={running} onClick={async () => { await api("/api/admin/media/scan", { method: "POST" }); scan.reload(); }}><FolderSync className="size-4" /> {running ? `Scanning ${scan.data?.status.progress ? `${scan.data.status.progress.done}/${scan.data.status.progress.total}` : "…"}` : "Scan library"}</Button>
          <Link href="/admin/media/new" className="btn-primary inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold"><Plus className="size-4" /> Add media</Link>
        </>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["library", "unmatched"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-4 py-1.5 text-sm transition ${tab === t ? "bg-accent text-white" : "bg-white/10 hover:bg-white/20"}`}>
            {t === "library" ? `Library${data ? ` (${data.titles.length})` : ""}` : `Needs matching${data ? ` (${data.unmatched.length})` : ""}`}
          </button>
        ))}
        {data && data.missing > 0 && <Badge tone="red"><AlertTriangle className="size-3" /> {data.missing} missing on disk</Badge>}
        {tab === "library" && <div className="ml-auto w-full sm:w-64"><Input aria-label="Filter" placeholder="Filter titles…" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
      </div>

      {tab === "library" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {loading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-[2/3]" />)}
          {data?.titles.map((t) => (
            <button key={t.id} onClick={() => setManage(t.id)} className="group text-left">
              <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface ring-accent transition group-hover:ring-2">
                {t.posterPath ? <img src={tmdbImg(t.posterPath, "w342")!} alt="" loading="lazy" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center p-2 text-center text-sm text-muted">{t.title}</div>}
                <span className="absolute left-1.5 top-1.5"><Badge tone={t.type === "show" ? "accent" : "default"}>{t.type === "show" ? "Series" : "Movie"}</Badge></span>
                {t.missing > 0 && <span className="absolute right-1.5 top-1.5"><Badge tone="red">missing</Badge></span>}
              </div>
              <p className="mt-1.5 truncate text-sm font-medium">{t.title}</p>
              <p className="text-xs text-muted">{t.year ?? "—"} · {t.type === "show" ? `${t.episodeCount} eps` : `${t.fileCount} file${t.fileCount > 1 ? "s" : ""}`} · {fmtBytes(t.sizeBytes)}</p>
            </button>
          ))}
          {data && !data.titles.length && <Card className="col-span-full py-14 text-center text-muted">{q ? "No titles match your filter." : <>Your library is empty. <Link href="/admin/media/new" className="text-violet-300 hover:underline">Add media</Link> or scan your folders.</>}</Card>}
        </div>
      )}

      {tab === "unmatched" && (
        <div className="space-y-2">
          {data?.unmatched.map((u) => (
            <Card key={u.id} className="flex flex-wrap items-center gap-3 !p-4">
              <FileVideo className="size-5 shrink-0 text-amber-300" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={u.path}>{u.rawName ?? u.path.split("/").pop()}</p><p className="truncate text-xs text-muted">{u.path} · {fmtBytes(u.size)}{u.durationSec ? ` · ${fmtDuration(u.durationSec)}` : ""}</p></div>
              <Button size="sm" onClick={() => setMatch(u)}><LinkIcon className="size-4" /> Match</Button>
              <Button size="sm" variant="ghost" className="text-red-300" title="Remove from library (keeps the file)" onClick={async () => { if (confirm("Remove this entry from the library? The file stays on disk but will be re-imported on the next scan.")) { await api(`/api/admin/media/file/${u.id}`, { method: "DELETE" }); reload(); } }}><Trash2 className="size-4" /></Button>
            </Card>
          ))}
          {data && !data.unmatched.length && <Card className="py-14 text-center text-muted">Everything is matched. 🎉</Card>}
        </div>
      )}

      <ManageTitle id={manage} onClose={() => setManage(null)} onChanged={reload} />
      <MatchFile file={match} onClose={() => setMatch(null)} onDone={() => { setMatch(null); reload(); }} />
    </>
  );
}

/* --------------------------------------------------------------- manage */

interface FileRow { id: string; path: string; size: number; status: string; source: string; container: string | null; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null; durationSec: number | null; subtitles: { id: string; label: string; language: string | null; format: string; source: string }[] }
interface Detail { id: string; type: string; tmdbId: number | null; title: string; year: number | null; files: FileRow[]; episodes: { id: string; season: number; number: number; name: string | null; files: FileRow[] }[] }

function ManageTitle({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = usePoll<Detail>(id ? `/api/admin/media/title/${id}` : null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [finder, setFinder] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await reload(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  async function autoFetch() {
    if (!data) return;
    setAuto(true); setErr(""); setNote("");
    try {
      const { report } = await api<{ report: { added: number; skipped: number; notFound: number; errors: string[] } }>("/api/admin/subtitles/auto", { method: "POST", body: { titleId: data.id } });
      setNote(`Added ${report.added} subtitle${report.added === 1 ? "" : "s"}${report.notFound ? `, ${report.notFound} not found` : ""}${report.skipped ? `, ${report.skipped} already present` : ""}.`);
      if (report.errors.length) setErr(report.errors[0]);
      await reload(); onChanged();
    } catch (e) { setErr((e as Error).message); }
    setAuto(false);
  }

  const FileCard = ({ f, label }: { f: FileRow; label?: string }) => (
    <div className="rounded-lg border border-line bg-bg/50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {label && <p className="font-semibold">{label}</p>}
          <p className="truncate text-xs text-muted" title={f.path}>{f.path}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/70">
            <span>{fmtBytes(f.size)}</span>{f.height ? <span>{f.height}p</span> : null}<span>{f.videoCodec}</span><span>{f.audioCodec}</span>{f.durationSec ? <span>{fmtDuration(f.durationSec)}</span> : null}
            {f.status !== "ready" && <Badge tone="red">{f.status}</Badge>}<Badge>{f.source}</Badge>
          </p>
        </div>
        <button className="rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-white" title="Find subtitles on OpenSubtitles.com" onClick={() => setFinder(f.id)}><Captions className="size-4" /></button>
        <label className="cursor-pointer rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-white" title="Upload subtitle (SRT, VTT, ASS)">
          <Subtitles className="size-4" />
          <input type="file" hidden accept=".srt,.vtt,.ass,.ssa" onChange={(e) => {
            const file = e.target.files?.[0]; e.target.value = "";
            if (!file) return;
            const lang = prompt("Language code (e.g. en, es, fr) — optional", "") ?? "";
            const form = new FormData(); form.set("file", file); form.set("language", lang);
            act(async () => { const r = await fetch(`/api/admin/media/file/${f.id}/subtitles`, { method: "POST", body: form }); if (!r.ok) throw new Error((await r.json()).error); });
          }} />
        </label>
        <button className="rounded-md p-1.5 text-red-300 hover:bg-white/10" title="Remove file from library" onClick={() => {
          if (!confirm("Remove this file from the library?")) return;
          const del = confirm("Also delete it from disk?\n\nOK = delete from disk, Cancel = keep the file");
          act(() => api(`/api/admin/media/file/${f.id}?deleteFile=${del ? 1 : 0}`, { method: "DELETE" }));
        }}><Trash2 className="size-4" /></button>
      </div>
      {f.subtitles.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {f.subtitles.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs">{s.label} <span className="text-white/40">{s.format}</span>
              <button aria-label="Remove subtitle" className="text-white/50 hover:text-red-300" onClick={() => act(() => api(`/api/admin/media/subtitle/${s.id}`, { method: "DELETE" }))}>×</button></span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Modal open={!!id} onClose={onClose} title={data ? `${data.title}${data.year ? ` (${data.year})` : ""}` : "Loading…"} wide>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="space-y-3">
          <ErrorNote msg={err} />
          {note && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{note}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted">Subtitles: upload a file, or fetch from OpenSubtitles.com.</p>
            <Button size="sm" variant="secondary" loading={auto} onClick={autoFetch}><Captions className="size-4" /> Auto-fetch missing</Button>
          </div>
          {data.files.map((f) => <FileCard key={f.id} f={f} />)}
          {data.episodes.map((e) => e.files.map((f) => <FileCard key={f.id} f={f} label={`S${e.season}E${e.number}${e.name ? ` · ${e.name}` : ""}`} />))}
          <div className="flex items-center justify-between pt-2">
            {data.tmdbId && <Link href={`/title/${data.type === "show" ? "tv" : "movie"}/${data.tmdbId}`} className="text-sm text-violet-300 hover:underline">Open title page</Link>}
            <Button variant="danger" size="sm" onClick={() => {
              if (!confirm(`Remove "${data.title}" and all its files from the library?`)) return;
              const del = confirm("Also delete the media files from disk?\n\nOK = delete from disk, Cancel = keep files");
              act(async () => { await api(`/api/admin/media/title/${data.id}?deleteFiles=${del ? 1 : 0}`, { method: "DELETE" }); onClose(); });
            }}><Trash2 className="size-4" /> Remove title</Button>
          </div>
        </div>
      )}
      <SubtitleFinder fileId={finder} title={data?.title ?? ""} open={!!finder} onClose={() => setFinder(null)} onAdded={() => { reload(); onChanged(); }} />
    </Modal>
  );
}

/* ---------------------------------------------------------------- match */

interface Hit { tmdbId: number; type: "movie" | "tv"; title: string; year: number | null; posterPath: string | null }

function MatchFile({ file, onClose, onDone }: { file: U | null; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<"movie" | "tv">("movie");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState<Hit | null>(null);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!file) return;
    const base = (file.rawName ?? file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").replace(/[._]/g, " ").replace(/\b(19|20)\d{2}\b.*$/, "").replace(/S\d{1,2}E\d{1,2}.*$/i, "").trim();
    setQ(base); setHits([]); setPick(null); setErr("");
    const m = /S(\d{1,2})E(\d{1,3})/i.exec(file.rawName ?? file.path);
    if (m) { setType("tv"); setSeason(+m[1]); setEpisode(+m[2]); }
  }, [file]);

  async function search() {
    setErr("");
    try { setHits((await api<{ results: Hit[] }>(`/api/admin/tmdb/search?q=${encodeURIComponent(q)}&type=${type}`)).results); } catch (e) { setErr((e as Error).message); }
  }
  async function link() {
    if (!file || !pick) return;
    setBusy(true); setErr("");
    try { await api(`/api/admin/media/file/${file.id}`, { method: "PATCH", body: { tmdbId: pick.tmdbId, mediaType: pick.type, season: pick.type === "tv" ? season : undefined, episode: pick.type === "tv" ? episode : undefined } }); onDone(); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal open={!!file} onClose={onClose} title="Match file to TMDB" wide>
      <p className="mb-3 truncate text-xs text-muted">{file?.path}</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div className="w-36"><Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value as "movie" | "tv"); setHits([]); setPick(null); }}><option value="movie">Movie</option><option value="tv">TV show</option></Select></div>
        <div className="flex-1"><Input aria-label="Title" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title" /></div>
        <Button type="submit"><Search className="size-4" /></Button>
      </form>
      <ErrorNote msg={err} />
      <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.tmdbId}>
            <button onClick={() => setPick(h)} className={`flex w-full items-center gap-3 rounded-lg p-2 text-left transition ${pick?.tmdbId === h.tmdbId ? "bg-accent/25" : "hover:bg-white/5"}`}>
              <span className="h-14 w-10 shrink-0 overflow-hidden rounded bg-surface-2">{h.posterPath && <img src={tmdbImg(h.posterPath, "w185")!} alt="" className="size-full object-cover" />}</span>
              <span className="font-medium">{h.title}</span><span className="text-sm text-muted">{h.year}</span>
            </button>
          </li>
        ))}
      </ul>
      {pick?.type === "tv" && (
        <div className="mt-3 grid grid-cols-2 gap-3"><Input label="Season" type="number" min={0} value={season} onChange={(e) => setSeason(+e.target.value)} /><Input label="Episode" type="number" min={1} value={episode} onChange={(e) => setEpisode(+e.target.value)} /></div>
      )}
      <Button className="mt-4 w-full" disabled={!pick} loading={busy} onClick={link}>Link to {pick?.title ?? "selection"}</Button>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted"><Upload className="size-3" /> Metadata, poster and episode info are pulled from TMDB.</p>
    </Modal>
  );
}
