"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Download, Loader2, Search, ShieldCheck } from "lucide-react";
import { Badge, Button, Input, api } from "./ui";
import { ErrorNote, Modal } from "@/app/admin/parts";

interface Result { fileId: number; language: string; release: string; fileName: string; downloads: number; hearingImpaired: boolean; hashMatch: boolean; trusted: boolean; aiTranslated: boolean; uploader: string | null }
export interface AddedSubtitle { id: string; label: string; language: string | null }

const LANGS: [string, string][] = [["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt-br", "Portuguese (BR)"], ["pt-pt", "Portuguese (PT)"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["tr", "Turkish"], ["ar", "Arabic"], ["ja", "Japanese"], ["ko", "Korean"], ["zh-cn", "Chinese"], ["sv", "Swedish"]];
const langLabel = (c: string) => LANGS.find(([k]) => k === c.toLowerCase())?.[1] ?? c.toUpperCase();

/** Search OpenSubtitles.com for a library file and attach the chosen subtitle. Admin only (server enforced). */
export function SubtitleFinder({ fileId, title, open, onClose, onAdded }: { fileId: string | null; title: string; open: boolean; onClose: () => void; onAdded: (s: AddedSubtitle) => void }) {
  const [langs, setLangs] = useState<string[] | null>(null); // null = server default (Settings → Subtitles)
  const [text, setText] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [quota, setQuota] = useState<number | null>(null);

  const run = useCallback(async (l: string[] | null, q: string) => {
    if (!fileId) return;
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams({ fileId });
      if (l?.length) qs.set("languages", l.join(","));
      if (q.trim()) qs.set("q", q.trim());
      const r = await api<{ results: Result[]; languages: string[] }>(`/api/admin/subtitles/search?${qs}`);
      setResults(r.results);
      setLangs((cur) => cur ?? r.languages);
    } catch (e) { setErr((e as Error).message); setResults(null); }
    setLoading(false);
  }, [fileId]);

  useEffect(() => { if (open) { setResults(null); setDone(new Set()); setLangs(null); setText(""); run(null, ""); } }, [open, fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (c: string) => {
    const cur = langs ?? [];
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c].slice(0, 8);
    if (!next.length) return;
    setLangs(next);
    run(next, text);
  };

  async function add(r: Result) {
    if (!fileId) return;
    setBusy(r.fileId); setErr("");
    try {
      const res = await api<{ subtitle: AddedSubtitle; remaining: number | null }>("/api/admin/subtitles/download", { method: "POST", body: { fileId, osFileId: r.fileId, language: r.language, release: r.release || undefined, hearingImpaired: r.hearingImpaired } });
      setDone((d) => new Set(d).add(r.fileId));
      if (res.remaining !== null) setQuota(res.remaining);
      onAdded(res.subtitle);
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  }

  const unconfigured = /not configured/i.test(err);
  return (
    <Modal open={open} onClose={onClose} title={`Find subtitles · ${title}`} wide>
      <div className="space-y-3">
        <p className="text-xs text-muted">Results come from <span className="text-white/80">OpenSubtitles.com</span>. Exact release matches (by file hash) are listed first.</p>
        <div className="flex flex-wrap gap-1.5">
          {[...new Set([...(langs ?? []), ...LANGS.map(([k]) => k)])].map((c) => (
            <button key={c} type="button" onClick={() => toggle(c)} className={`rounded-full px-2.5 py-1 text-xs transition ${langs?.includes(c) ? "bg-accent text-white" : "bg-white/8 text-white/70 hover:bg-white/15"}`}>{langLabel(c)}</button>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(langs, text); }}>
          <div className="flex-1"><Input aria-label="Search by title" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by title instead (optional)" /></div>
          <Button type="submit" loading={loading}><Search className="size-4" /></Button>
        </form>
        <ErrorNote msg={err} />
        {unconfigured && <Link href="/admin/settings" className="inline-block text-sm text-violet-300 hover:underline">Open settings →</Link>}
        {loading && !results && <p className="flex items-center gap-2 py-6 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Searching…</p>}
        <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1">
          {results?.map((r) => (
            <li key={r.fileId} className="flex items-center gap-3 rounded-lg border border-line bg-bg/50 p-2.5 text-sm">
              <Badge tone="accent">{r.language.toUpperCase()}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate" title={r.release || r.fileName}>{r.release || r.fileName || "Subtitle"}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                  {r.hashMatch && <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="size-3" /> exact match</span>}
                  {r.trusted && <span className="inline-flex items-center gap-1 text-sky-300"><ShieldCheck className="size-3" /> trusted</span>}
                  {r.hearingImpaired && <span>SDH</span>}
                  {r.aiTranslated && <span className="text-amber-300">machine translated</span>}
                  <span>{r.downloads.toLocaleString()} downloads</span>
                  {r.uploader && <span>by {r.uploader}</span>}
                </p>
              </div>
              {done.has(r.fileId) ? <Badge tone="green"><Check className="size-3" /> added</Badge> : (
                <Button size="sm" variant="secondary" loading={busy === r.fileId} disabled={busy !== null} onClick={() => add(r)}><Download className="size-4" /> Add</Button>
              )}
            </li>
          ))}
        </ul>
        {results && !results.length && !loading && <p className="py-6 text-center text-sm text-muted">No subtitles found for these languages. Try other languages or a title search.</p>}
        {quota !== null && <p className="text-xs text-muted">{quota} downloads left today on your OpenSubtitles account.</p>}
      </div>
    </Modal>
  );
}
