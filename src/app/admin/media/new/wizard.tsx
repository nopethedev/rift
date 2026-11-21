"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, CheckCircle2, FolderInput, HardDriveUpload, Magnet, Search, Trash2, UploadCloud, XCircle, Zap } from "lucide-react";
import { fmtBytes, tmdbImg } from "@/lib/types";
import { Badge, Button, Card, Input, ProgressBar, Select, Skeleton, api } from "@/components/ui";
import { ErrorNote, PageHeader } from "../../parts";
import { FileSelector, type Preview, defaultSelection } from "../../torrent-parts";

type Source = "upload" | "torrent" | "folder";
interface Hit { tmdbId: number; type: "movie" | "tv"; title: string; year: number | null; posterPath: string | null; overview?: string }
interface TorrentResult { id: string; title: string; provider: string; seeds: number; peers: number; size: string; sizeBytes?: number; magnet?: string; torrentUrl?: string; infoHash?: string; time?: string; desc?: string; raw?: Record<string, string | undefined> }

const STEP_LABEL: Record<Source, string[]> = {
  upload: ["Source", "Title", "Upload files"],
  torrent: ["Source", "Title", "Find & download"],
  folder: ["Source", "Folder"],
};

export function Wizard() {
  const params = useSearchParams();
  const preTmdb = Number(params.get("tmdbId")) || 0;
  const preType = params.get("type") === "tv" ? "tv" : params.get("type") === "movie" ? "movie" : null;

  const [source, setSource] = useState<Source | null>(null);
  const [title, setTitle] = useState<Hit | null>(null);
  const [step, setStep] = useState(0);

  // Deep link from a discovery-only title: preselect it
  useEffect(() => {
    if (!preTmdb || !preType) return;
    fetch(`/api/tmdb/details?type=${preType}&id=${preTmdb}`).then((r) => r.json()).then((d) => {
      if (d.title) {
        setTitle({ tmdbId: preTmdb, type: preType, title: d.title, year: d.year, posterPath: d.backdropPath });
        if (params.get("source") === "torrent") { setSource("torrent"); setStep(2); }
      }
    }).catch(() => {});
  }, [preTmdb, preType]);

  const labels = STEP_LABEL[source ?? "upload"];
  const choose = (s: Source) => { setSource(s); setStep(s === "folder" ? 1 : title ? 2 : 1); };

  return (
    <>
      <PageHeader title="Add media" subtitle="Upload your own files, find a download, or import a folder — then link it to a movie or TV show." />
      <ol className="mb-8 flex flex-wrap items-center gap-2 text-sm">
        {labels.map((l, i) => (
          <li key={l} className="flex items-center gap-2">
            <span className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${i < step ? "bg-accent text-white" : i === step ? "border border-accent text-accent" : "border border-line text-muted"}`}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
            <span className={i === step ? "font-semibold" : "text-muted"}>{l}</span>
            {i < labels.length - 1 && <span className="mx-1 h-px w-6 bg-line" />}
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div key={`${source}-${step}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          {step === 0 && <ChooseSource onChoose={choose} />}
          {step === 1 && source === "folder" && <ImportFolder onBack={() => setStep(0)} />}
          {step === 1 && source !== "folder" && <PickTitle title={title} onPick={setTitle} onBack={() => setStep(0)} onNext={() => setStep(2)} />}
          {step === 2 && title && source === "upload" && <UploadStep title={title} onBack={() => setStep(1)} />}
          {step === 2 && title && source === "torrent" && <TorrentStep title={title} onBack={() => setStep(1)} />}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------ step 0 */

function ChooseSource({ onChoose }: { onChoose: (s: Source) => void }) {
  const opts: { id: Source; icon: typeof UploadCloud; title: string; text: string }[] = [
    { id: "upload", icon: HardDriveUpload, title: "Upload my own media", text: "Send video files (and subtitles) from this computer and connect them to a movie or TV show." },
    { id: "torrent", icon: Magnet, title: "Search & torrent", text: "Pick a movie or show, search torrent indexers, choose files and download them into your library." },
    { id: "folder", icon: FolderInput, title: "Import a folder", text: "Scan a directory that already exists on the server and match everything automatically." },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {opts.map((o) => (
        <button key={o.id} onClick={() => onChoose(o.id)} className="group rounded-2xl border border-line bg-surface p-6 text-left transition hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-[0_10px_40px_-12px_rgba(139,92,246,0.5)]">
          <span className="btn-primary mb-4 inline-flex size-12 items-center justify-center rounded-xl"><o.icon className="size-6" /></span>
          <h3 className="text-lg font-semibold">{o.title}</h3>
          <p className="mt-1 text-sm text-muted">{o.text}</p>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ step 1 */

function PickTitle({ title, onPick, onBack, onNext }: { title: Hit | null; onPick: (h: Hit | null) => void; onBack: () => void; onNext: () => void }) {
  const [type, setType] = useState<"movie" | "tv">(title?.type ?? "movie");
  const [q, setQ] = useState(title?.title ?? "");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const search = useCallback(async () => {
    if (q.trim().length < 2) return;
    setBusy(true); setErr("");
    try { setHits((await api<{ results: Hit[] }>(`/api/admin/tmdb/search?q=${encodeURIComponent(q)}&type=${type}`)).results); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }, [q, type]);

  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-lg font-semibold">Which movie or TV show is this?</h2>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div className="w-36"><Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value as "movie" | "tv"); setHits([]); onPick(null); }}><option value="movie">Movie</option><option value="tv">TV show</option></Select></div>
        <div className="min-w-48 flex-1"><Input aria-label="Title" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search TMDB…" /></div>
        <Button type="submit" loading={busy}><Search className="size-4" /> Search</Button>
      </form>
      <ErrorNote msg={err} />
      {title && !hits.length && <SelectedTitle t={title} />}
      <ul className="grid gap-2 sm:grid-cols-2">
        {busy && <><Skeleton className="h-24" /><Skeleton className="h-24" /></>}
        {hits.map((h) => (
          <li key={h.tmdbId}>
            <button onClick={() => onPick(h)} className={`flex h-full w-full gap-3 rounded-xl border p-2.5 text-left transition ${title?.tmdbId === h.tmdbId && title.type === h.type ? "border-accent bg-accent/15" : "border-line bg-surface hover:border-white/30"}`}>
              <span className="h-24 w-16 shrink-0 overflow-hidden rounded-md bg-surface-2">{h.posterPath && <img src={tmdbImg(h.posterPath, "w185")!} alt="" className="size-full object-cover" />}</span>
              <span className="min-w-0"><span className="block font-semibold">{h.title} <span className="font-normal text-muted">{h.year}</span></span><span className="mt-1 line-clamp-3 text-xs text-muted">{h.overview}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-between pt-2"><Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button><Button disabled={!title} onClick={onNext}>Continue</Button></div>
    </div>
  );
}

function SelectedTitle({ t }: { t: Hit }) {
  return (
    <Card className="flex items-center gap-3 !p-3">
      <span className="h-16 w-11 shrink-0 overflow-hidden rounded bg-surface-2">{t.posterPath && <img src={tmdbImg(t.posterPath, "w185")!} alt="" className="size-full object-cover" />}</span>
      <div><p className="font-semibold">{t.title} <span className="font-normal text-muted">{t.year}</span></p><Badge tone="accent">{t.type === "tv" ? "TV show" : "Movie"}</Badge></div>
    </Card>
  );
}

/* ------------------------------------------------------------ step 2: upload */

interface UpItem { id: string; file: File; season: number; episode: number; state: "ready" | "uploading" | "done" | "error"; progress: number; error?: string; subs: File[] }

const VIDEO_RE = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|flv|mpg|mpeg|ogv)$/i;
const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;
const parseEp = (name: string) => {
  const m = /S(\d{1,2})[ ._-]?E(\d{1,3})/i.exec(name) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(name);
  return m ? { season: +m[1], episode: +m[2] } : null;
};

function xhrUpload(url: string, file: File, onProgress: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let j: any = {}; try { j = JSON.parse(x.responseText); } catch { /* ignore */ } x.status < 300 ? resolve(j) : reject(new Error(j.error ?? `Upload failed (${x.status})`)); };
    x.onerror = () => reject(new Error("Network error during upload"));
    x.send(file);
  });
}

function UploadStep({ title, onBack }: { title: Hit; onBack: () => void }) {
  const [items, setItems] = useState<UpItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [running, setRunning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isTv = title.type === "tv";
  const [defSeason, setDefSeason] = useState(1);

  const add = (files: File[]) => {
    const videos = files.filter((f) => VIDEO_RE.test(f.name));
    const subs = files.filter((f) => SUB_RE.test(f.name));
    setItems((cur) => {
      let next = [...cur, ...videos.slice(0, isTv ? 500 : Math.max(0, 1 - cur.length)).map((file, i) => {
        const p = parseEp(file.name);
        return { id: crypto.randomUUID(), file, season: p?.season ?? defSeason, episode: p?.episode ?? cur.length + i + 1, state: "ready" as const, progress: 0, subs: [] as File[] };
      })];
      for (const s of subs) {
        const base = s.name.replace(SUB_RE, "").toLowerCase();
        const target = next.find((n) => base.startsWith(n.file.name.replace(/\.[^.]+$/, "").toLowerCase())) ?? next.find((n) => { const p = parseEp(s.name); return p && p.season === n.season && p.episode === n.episode; });
        if (target) next = next.map((n) => (n === target ? { ...n, subs: [...n.subs, s] } : n));
      }
      return next;
    });
  };
  const patch = (id: string, p: Partial<UpItem>) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)));

  async function run() {
    setRunning(true);
    for (const it of items.filter((i) => i.state === "ready" || i.state === "error")) {
      patch(it.id, { state: "uploading", progress: 0, error: undefined });
      try {
        const qs = new URLSearchParams({ filename: it.file.name, tmdbId: String(title.tmdbId), mediaType: title.type });
        if (isTv) { qs.set("season", String(it.season)); qs.set("episode", String(it.episode)); }
        const r = await xhrUpload(`/api/admin/upload?${qs}`, it.file, (p) => patch(it.id, { progress: p }));
        for (const s of it.subs) {
          const f = new FormData(); f.set("file", s);
          await fetch(`/api/admin/media/file/${r.result.mediaFileId}/subtitles`, { method: "POST", body: f }).catch(() => {});
        }
        patch(it.id, { state: "done", progress: 1 });
      } catch (e) { patch(it.id, { state: "error", error: (e as Error).message }); }
    }
    setRunning(false);
  }

  const allDone = items.length > 0 && items.every((i) => i.state === "done");
  return (
    <div className="max-w-3xl space-y-4">
      <SelectedTitle t={title} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add([...e.dataTransfer.files]); }}
        onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition ${drag ? "border-accent bg-accent/10" : "border-line hover:border-accent/60"}`}
      >
        <UploadCloud className="size-10 text-accent" />
        <p className="font-semibold">Drop {isTv ? "episode files" : "the movie file"} here, or click to browse</p>
        <p className="text-sm text-muted">MKV, MP4, AVI, MOV, WebM… Include .srt / .vtt / .ass files with matching names to attach subtitles.</p>
        <input ref={input} type="file" multiple={isTv} hidden accept="video/*,.mkv,.avi,.ts,.m2ts,.srt,.vtt,.ass,.ssa" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      {isTv && <div className="w-40"><Input label="Default season" type="number" min={0} value={defSeason} onChange={(e) => setDefSeason(+e.target.value)} hint="For files without S01E02 in the name" /></div>}

      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id}><Card className="!p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{i.file.name}</p><p className="text-xs text-muted">{fmtBytes(i.file.size)}{i.subs.length ? ` · ${i.subs.length} subtitle${i.subs.length > 1 ? "s" : ""}` : ""}</p></div>
                {isTv && i.state !== "done" && (
                  <div className="flex items-center gap-1.5 text-xs">S<input aria-label="Season" type="number" min={0} value={i.season} onChange={(e) => patch(i.id, { season: +e.target.value })} className="w-14 rounded-md border border-line bg-bg px-2 py-1" />E<input aria-label="Episode" type="number" min={1} value={i.episode} onChange={(e) => patch(i.id, { episode: +e.target.value })} className="w-16 rounded-md border border-line bg-bg px-2 py-1" /></div>
                )}
                {i.state === "done" ? <CheckCircle2 className="size-5 text-emerald-400" /> : i.state === "error" ? <XCircle className="size-5 text-red-400" /> : !running && <button aria-label="Remove" onClick={() => setItems((c) => c.filter((x) => x.id !== i.id))} className="text-muted hover:text-red-300"><Trash2 className="size-4" /></button>}
              </div>
              {(i.state === "uploading" || i.state === "done") && <ProgressBar className="mt-2" value={i.progress} />}
              {i.error && <p className="mt-2 text-xs text-red-300">{i.error}</p>}
            </Card></li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
        {allDone ? <Link href="/admin/media" className="btn-primary rounded-lg px-5 py-2.5 text-sm font-semibold">Done — view library</Link> : <Button onClick={run} loading={running} disabled={!items.some((i) => i.state === "ready" || i.state === "error")}>Upload {items.filter((i) => i.state !== "done").length || ""} file{items.length === 1 ? "" : "s"}</Button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ step 2: torrent */

function buildQuery(t: Hit, season: number | null, episode: number | null) {
  if (t.type === "tv") return `${t.title}${season ? ` S${String(season).padStart(2, "0")}${episode ? `E${String(episode).padStart(2, "0")}` : ""}` : ""}`;
  return `${t.title}${t.year ? ` ${t.year}` : ""}`;
}

async function startStream(router: ReturnType<typeof useRouter>, body: object): Promise<string | null> {
  try {
    const r = await api<{ stream: { id: string } }>("/api/admin/torrent-streams", { method: "POST", body });
    router.push(`/stream/${r.stream.id}`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function TorrentStep({ title, onBack }: { title: Hit; onBack: () => void }) {
  const router = useRouter();
  const isTv = title.type === "tv";
  const [seasons, setSeasons] = useState<{ number: number; name: string }[]>([]);
  const [season, setSeason] = useState<number | null>(isTv ? 1 : null);
  const [q, setQ] = useState(buildQuery(title, isTv ? 1 : null, null));
  const [results, setResults] = useState<TorrentResult[] | null>(null);
  const [provs, setProvs] = useState<{ name: string; ok: boolean; count: number; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<TorrentResult | null>(null);
  const [mode, setMode] = useState<"search" | "paste">("search");

  useEffect(() => {
    if (isTv) api<{ seasons: { number: number; name: string }[] }>(`/api/admin/tmdb/search?tvId=${title.tmdbId}`).then((r) => setSeasons(r.seasons)).catch(() => {});
  }, [isTv, title.tmdbId]);
  useEffect(() => { setQ(buildQuery(title, season, null)); }, [season, title]);

  async function search() {
    setBusy(true); setErr(""); setResults(null);
    try {
      const r = await api<{ results: TorrentResult[]; providers: typeof provs }>(`/api/admin/torrents/search?q=${encodeURIComponent(q)}&category=${isTv ? "tv" : "movies"}`);
      setResults(r.results); setProvs(r.providers);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (picked || mode === "paste") return <TorrentPick title={title} season={season} result={picked} onBack={() => { setPicked(null); setMode("search"); }} />;
  return (
    <div className="max-w-4xl space-y-4">
      <SelectedTitle t={title} />
      <p className="text-xs text-muted">Only download content you own or are licensed to use. Results come from your configured indexers; nothing is downloaded until you pick a result and confirm the files.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
        {isTv && <div className="w-44"><Select label="Season" value={season ?? ""} onChange={(e) => setSeason(e.target.value ? +e.target.value : null)}><option value="">Complete series</option>{seasons.map((s) => <option key={s.number} value={s.number}>{s.name}</option>)}</Select></div>}
        <div className="min-w-56 flex-1"><Input label="Search query" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button type="submit" loading={busy}><Search className="size-4" /> Search</Button>
        <Button type="button" variant="secondary" onClick={() => setMode("paste")}><Magnet className="size-4" /> Paste magnet</Button>
      </form>
      <ErrorNote msg={err} />
      {provs.length > 0 && <div className="flex flex-wrap gap-1.5">{provs.map((p) => <span key={p.name} title={p.error}><Badge tone={p.ok ? "green" : "red"}>{p.name}: {p.ok ? p.count : "failed"}</Badge></span>)}</div>}
      {busy && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>}
      {results && (
        <Card className="overflow-x-auto !p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-3">Name</th><th>Size</th><th>Seeds</th><th>Peers</th><th>Source</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {results.map((r) => (
                <tr key={r.id + r.provider} className="hover:bg-white/5">
                  <td className="max-w-md px-4 py-2.5"><span className="line-clamp-2 break-words">{r.title}</span></td>
                  <td className="whitespace-nowrap">{r.size}</td>
                  <td className={r.seeds > 0 ? "text-emerald-400" : "text-muted"}>{r.seeds}</td><td className="text-muted">{r.peers}</td>
                  <td><Badge>{r.provider}</Badge></td>
                  <td className="whitespace-nowrap pr-3 text-right">
                    <Button size="sm" className="mr-1.5" title="Stream now: buffers a few MB, plays while downloading, deletes itself afterwards" onClick={async () => { setErr(""); const m = await startStream(router, { result: r }); if (m) setErr(m); }}><Zap className="size-3.5" /> Stream</Button>
                    <Button size="sm" variant="secondary" onClick={() => setPicked(r)}>Download</Button>
                  </td>
                </tr>
              ))}
              {!results.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">No results. Try a shorter query, another season, or enable more providers in Settings.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
      <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
    </div>
  );
}

function TorrentPick({ title, season, result, onBack }: { title: Hit; season: number | null; result: TorrentResult | null; onBack: () => void }) {
  const router = useRouter();
  const [magnet, setMagnet] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [added, setAdded] = useState(false);

  const payload = useCallback((extra: Record<string, unknown> = {}) => {
    if (file) { const f = new FormData(); f.set("file", file); for (const [k, v] of Object.entries(extra)) f.set(k, JSON.stringify(v)); return { body: f } as RequestInit; }
    const base = result ? { result } : { magnet: magnet.trim() };
    return { headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, ...extra }) } as RequestInit;
  }, [file, result, magnet]);

  const loadPreview = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/admin/downloads/preview", { method: "POST", ...payload() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setPreview(j.preview); setSel(defaultSelection(j.preview.files));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }, [payload]);

  useEffect(() => { if (result) loadPreview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setBusy(true); setErr("");
    try {
      const extra = { selectedFiles: [...sel], tmdbId: title.tmdbId, mediaType: title.type, ...(title.type === "tv" && season ? { season } : {}) };
      const r = await fetch("/api/admin/downloads", { method: "POST", ...payload(extra) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setAdded(true);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }

  if (added) {
    return (
      <Card className="max-w-xl space-y-3 text-center">
        <CheckCircle2 className="mx-auto size-12 text-emerald-400" />
        <h2 className="text-xl font-bold">Download started</h2>
        <p className="text-sm text-muted">When it finishes, files are scanned and linked to <b className="text-white">{title.title}</b> automatically.</p>
        <Link href="/admin/downloads" className="btn-primary inline-block rounded-lg px-5 py-2.5 text-sm font-semibold">Open downloads</Link>
      </Card>
    );
  }
  return (
    <div className="max-w-3xl space-y-4">
      <SelectedTitle t={title} />
      {!result && !preview && (
        <Card className="space-y-3">
          <Input label="Magnet link" value={magnet} onChange={(e) => setMagnet(e.target.value)} placeholder="magnet:?xt=urn:btih:…" />
          <label className="block text-sm"><span className="mb-1.5 block font-medium text-white/80">…or a .torrent file</span><input type="file" accept=".torrent" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" /></label>
          <Button onClick={loadPreview} loading={busy} disabled={!magnet.trim() && !file}>Fetch file list</Button>
        </Card>
      )}
      {result && !preview && !err && <div className="space-y-2"><p className="text-sm text-muted">Fetching metadata from peers for “{result.title}”… (up to 45 s)</p><Skeleton className="h-40" /></div>}
      {preview && (
        <Card className="space-y-4">
          <div><p className="font-semibold">{preview.name}</p><p className="text-xs text-muted">{fmtBytes(preview.totalSize)} · {preview.files.length} files — choose what to download</p></div>
          <FileSelector files={preview.files} selected={sel} onChange={setSel} />
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={add} loading={busy} disabled={!sel.size}>Download &amp; link to {title.title}{title.type === "tv" && season ? ` · S${season}` : ""}</Button>
            <Button variant="secondary" disabled={!sel.size || busy} onClick={async () => {
              setErr("");
              const vids = preview.files.filter((f) => sel.has(f.index) && /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|flv|mpg|mpeg|ogv)$/i.test(f.path));
              const fileIndex = vids.length === 1 ? vids[0].index : undefined;
              if (file) { const f = new FormData(); f.set("file", file); if (fileIndex !== undefined) f.set("fileIndex", String(fileIndex)); const r = await fetch("/api/admin/torrent-streams", { method: "POST", body: f }); const j = await r.json(); if (!r.ok) return setErr(j.error); router.push(`/stream/${j.stream.id}`); return; }
              const m = await startStream(router, { ...(result ? { result } : { magnet: magnet.trim() }), fileIndex });
              if (m) setErr(m);
            }}><Zap className="size-4" /> Stream now (no download)</Button>
          </div>
        </Card>
      )}
      <ErrorNote msg={err} />
      <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
    </div>
  );
}

/* ------------------------------------------------------------ folder import */

function ImportFolder({ onBack }: { onBack: () => void }) {
  const [dir, setDir] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const status = useScan(busy);

  async function start() {
    setBusy(true); setErr("");
    try { await api("/api/admin/media/scan", { method: "POST", body: dir.trim() ? { dir: dir.trim() } : {} }); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  useEffect(() => { if (busy && status && !status.running && status.finishedAt) setBusy(false); }, [busy, status]);
  const report = status?.lastReports?.[0];
  return (
    <div className="max-w-2xl space-y-4">
      <Card className="space-y-4">
        <Input label="Folder on the server" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/media/movies  (leave empty to scan all library folders)" hint="Absolute path. Files stay where they are; Rift probes them, matches TMDB metadata and picks up sidecar subtitles." />
        <ErrorNote msg={err} />
        <Button onClick={start} loading={busy}><FolderInput className="size-4" /> {busy ? `Scanning ${status?.progress ? `${status.progress.done}/${status.progress.total}` : "…"}` : "Start import"}</Button>
        {status?.progress?.current && busy && <p className="truncate text-xs text-muted">{status.progress.current}</p>}
        {!busy && report && (
          <div className="rounded-lg border border-line bg-bg/60 p-3 text-sm">
            Last scan: <b>{report.imported}</b> imported · <b>{report.matched}</b> matched · <b className={report.unmatched ? "text-amber-300" : ""}>{report.unmatched}</b> need manual matching · {report.errors.length} errors.
            {report.unmatched > 0 && <> <Link href="/admin/media" className="text-violet-300 hover:underline">Review</Link></>}
          </div>
        )}
      </Card>
      <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back</Button>
    </div>
  );
}

function useScan(active: boolean) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    let live = true;
    const tick = () => fetch("/api/admin/media/scan").then((r) => r.json()).then((j) => live && setS(j.status)).catch(() => {});
    tick();
    if (!active) return () => { live = false; };
    const t = setInterval(tick, 1500);
    return () => { live = false; clearInterval(t); };
  }, [active]);
  return s as { running: boolean; finishedAt: string | null; progress: { done: number; total: number; current?: string } | null; lastReports: { imported: number; matched: number; unmatched: number; errors: unknown[] }[] } | null;
}
