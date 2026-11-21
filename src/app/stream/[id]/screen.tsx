"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, FileVideo, Trash2, Zap } from "lucide-react";
import { Button, ProgressBar, api } from "@/components/ui";
import { fmtBytes } from "@/lib/types";
import { Player } from "@/components/player/player";

interface S {
  id: string; infoHash: string; meta: { title: string; subtitle?: string; backPath?: string; type?: "movie" | "tv"; tmdbId?: number; season?: number; episode?: number } | null; name: string; status: "metadata" | "choose" | "buffering" | "ready" | "error"; error?: string | null;
  files: { index: number; path: string; size: number; video: boolean }[];
  fileName: string | null; fileSize: number; prebuffer: number; progress: number; downloaded: number; downloadSpeed: number; peers: number;
}

/** Buffering screen for an on-demand torrent stream; hands over to the player once the first MBs are in. */
export function StreamScreen({ id }: { id: string }) {
  const router = useRouter();
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState("");
  const [started] = useState(() => Date.now());
  const ready = useRef(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api<{ stream: S }>(`/api/ondemand/${id}`);
        if (!live) return;
        setS(r.stream);
        if (r.stream.status === "ready") ready.current = true;
      } catch (e) {
        if (live) setErr((e as Error).message);
      }
    };
    tick();
    // after ready the player heartbeat takes over
    const t = setInterval(() => { if (!ready.current) tick(); }, 800);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  if (s?.status === "ready") return <Player torrent fileId={id} />;

  const home = s?.meta?.backPath ?? "/";
  const stop = async () => { await api(`/api/ondemand/${id}`, { method: "DELETE" }).catch(() => {}); router.push(home); };
  // Started from a title: a dead source can be swapped for the next-best one.
  const another = async () => {
    if (!s?.meta?.tmdbId || !s.meta.type) return;
    await api(`/api/ondemand/${id}`, { method: "DELETE" }).catch(() => {});
    const q = new URLSearchParams({ type: s.meta.type, tmdbId: String(s.meta.tmdbId), exclude: s.infoHash });
    if (s.meta.season !== undefined) q.set("season", String(s.meta.season));
    if (s.meta.episode !== undefined) q.set("episode", String(s.meta.episode));
    router.replace(`/stream/start?${q}`);
  };
  const failed = err || (s?.status === "error" ? s.error : "");

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <Link href={home} className="absolute left-5 top-5 flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft className="size-4" /> Back</Link>
      {failed ? (
        <>
          <AlertTriangle className="size-12 text-amber-400" />
          <p className="max-w-md text-lg">{failed}</p>
          <div className="flex gap-3">
            {s?.meta?.tmdbId && <Button onClick={another}>Try another source</Button>}
            <Button variant="secondary" onClick={stop}>{s?.meta ? "Go back" : "Back to search"}</Button>
          </div>
        </>
      ) : s?.status === "choose" ? (
        <div className="w-full max-w-xl text-left">
          <h1 className="mb-1 text-2xl font-bold">Choose what to stream</h1>
          <p className="mb-4 text-sm text-muted">{s.name} contains several videos.</p>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-xl border border-line bg-surface">
            {s.files.filter((f) => f.video).map((f) => (
              <li key={f.index}>
                <button onClick={() => api(`/api/ondemand/${id}`, { method: "POST", body: { action: "select", fileIndex: f.index } }).catch((e) => setErr(e.message))} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/5">
                  <FileVideo className="size-5 shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate text-sm">{f.path}</span><span className="shrink-0 text-xs text-muted">{fmtBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <span className="btn-primary flex size-20 items-center justify-center rounded-2xl"><Zap className="size-10 animate-pulse" /></span>
          <div>
            <h1 className="text-2xl font-bold">{!s || s.status === "metadata" ? "Finding peers…" : "Buffering the first few MB…"}</h1>
            <p className="mx-auto mt-1 max-w-md truncate text-sm text-muted">{s?.meta ? `${s.meta.title}${s.meta.subtitle ? ` · ${s.meta.subtitle}` : ""}` : s?.fileName ?? s?.name ?? "Connecting"}</p>
          </div>
          <div className="w-full max-w-md space-y-2">
            <ProgressBar value={s?.status === "buffering" ? s.prebuffer : 0} />
            <div className="flex justify-between text-xs text-muted">
              <span>{s?.status === "buffering" ? `${Math.round(s.prebuffer * 100)}%` : `${Math.round((Date.now() - started) / 1000)}s`}</span>
              <span>{s ? `${s.peers} peers · ${fmtBytes(s.downloadSpeed)}/s` : ""}</span>
            </div>
          </div>
          <p className="max-w-sm text-xs text-muted">Streaming on demand: nothing is added to your library. The downloaded data is deleted about a minute after you stop watching.</p>
          <Button variant="ghost" className="text-red-300" onClick={stop}><Trash2 className="size-4" /> Cancel &amp; delete</Button>
        </>
      )}
    </main>
  );
}
