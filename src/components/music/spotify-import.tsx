"use client";
// Paste one or more Spotify links (playlists, albums, a profile, or whatever the Spotify app's Share button copies),
// see what they contain, import the ones you tick. Only names/artists/order are read; audio never comes from Spotify.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { api, Button } from "@/components/ui";

interface Entry { url: string; kind: "playlist" | "album"; id: string; name?: string; tracks?: number; owner?: string; artworkUrl?: string | null }
interface PreviewItem { input: string; entries: Entry[]; error?: string; user?: string }
type Status = { s: "wait" } | { s: "busy" } | { s: "done"; id: string; imported: number; truncated: boolean } | { s: "error"; msg: string };

export function SpotifyImporter({ initialText = "", autoPreview = false, onImported }: { initialText?: string; autoPreview?: boolean; onImported?: (n: number) => void }) {
  const [text, setText] = useState(initialText);
  const [items, setItems] = useState<PreviewItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [err, setErr] = useState("");
  const started = useRef(false);

  async function preview(t = text) {
    setBusy("preview"); setErr(""); setStatus({});
    try {
      const r = await api<{ items: PreviewItem[] }>("/api/music/playlists/import/preview", { method: "POST", body: { text: t } });
      setItems(r.items);
      setPicked(new Set(r.items.flatMap((i) => i.entries.map((e) => e.url))));
    } catch (e) { setErr((e as Error).message); setItems(null); }
    setBusy(null);
  }
  useEffect(() => { if (autoPreview && initialText && !started.current) { started.current = true; void preview(initialText); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function run() {
    const todo = (items ?? []).flatMap((i) => i.entries).filter((e) => picked.has(e.url));
    setBusy("import");
    setStatus(Object.fromEntries(todo.map((e) => [e.url, { s: "wait" } as Status])));
    let n = 0;
    for (const e of todo) {
      setStatus((s) => ({ ...s, [e.url]: { s: "busy" } }));
      try {
        const r = await api<{ id: string; imported: number; truncated: boolean }>("/api/music/playlists/import", { method: "POST", body: { url: e.url } });
        n++;
        setStatus((s) => ({ ...s, [e.url]: { s: "done", id: r.id, imported: r.imported, truncated: r.truncated } }));
      } catch (x) { setStatus((s) => ({ ...s, [e.url]: { s: "error", msg: (x as Error).message } })); }
    }
    setBusy(null);
    onImported?.(n);
  }

  const all = (items ?? []).flatMap((i) => i.entries);
  const count = all.filter((e) => picked.has(e.url)).length;
  const finished = all.length > 0 && all.every((e) => !picked.has(e.url) || ["done", "error"].includes(status[e.url]?.s ?? ""));
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-white/80">Spotify links</span>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={3} spellCheck={false}
          placeholder={"https://open.spotify.com/playlist/…\nhttps://spotify.link/…  (one per line, or a profile link for all its public playlists)"}
          className="w-full resize-y rounded-lg border border-line bg-bg/70 px-3 py-2 text-sm outline-none placeholder:text-white/35 focus:border-accent"
        />
      </label>
      {!items && <Button onClick={() => void preview()} loading={busy === "preview"} disabled={text.trim().length < 10}>Continue</Button>}
      {err && <p role="alert" className="text-sm text-red-300">{err}</p>}

      {items && (
        <>
          <ul className="divide-y divide-white/5 rounded-lg border border-line">
            {items.map((it) => (
              <li key={it.input} className="px-3 py-2">
                {it.user && <p className="pb-1 text-xs text-muted">Public playlists of {it.user}{it.entries.length ? ` (${it.entries.length})` : ""}</p>}
                {it.error && <p className="flex items-start gap-2 text-sm text-amber-300"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span><span className="break-all text-white/60">{it.input}</span><br />{it.error}</span></p>}
                {it.entries.map((e) => {
                  const st = status[e.url];
                  return (
                    <div key={e.url} className="flex items-center gap-3 py-1">
                      <input type="checkbox" aria-label={`Import ${e.name ?? e.url}`} checked={picked.has(e.url)} disabled={!!busy || st?.s === "done"} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(e.url)) n.delete(e.url); else n.add(e.url); return n; })} className="size-4 accent-violet-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{e.name ?? (e.kind === "album" ? "Album" : "Playlist")}{!e.name && <span className="text-muted"> · {e.id}</span>}</span>
                        {(e.tracks !== undefined || e.owner) && <span className="block truncate text-xs text-muted">{[e.tracks !== undefined ? `${e.tracks} songs` : null, e.owner].filter(Boolean).join(" · ")}</span>}
                      </span>
                      <span className="shrink-0 text-xs">
                        {st?.s === "wait" && <span className="text-muted">Waiting</span>}
                        {st?.s === "busy" && <span className="inline-flex items-center gap-1 text-muted"><Loader2 className="size-3.5 animate-spin" /> Importing</span>}
                        {st?.s === "done" && <Link href={`/music/playlists/${st.id}`} className="inline-flex items-center gap-1 text-emerald-300 hover:underline"><Check className="size-3.5" /> {st.imported} songs{st.truncated ? " (first 100)" : ""}</Link>}
                        {st?.s === "error" && <span className="text-red-300" title={st.msg}>Failed</span>}
                      </span>
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
          {Object.values(status).some((s) => s.s === "error") && <p className="text-xs text-red-300">{Object.values(status).flatMap((s) => (s.s === "error" ? [s.msg] : []))[0]}</p>}
          {Object.values(status).some((s) => s.s === "done" && s.truncated) && <p className="text-xs text-muted">Without a Spotify client id/secret (Admin → Music → Settings), Spotify only shows the first 100 songs of a playlist.</p>}
          <div className="flex flex-wrap gap-2">
            {!finished && <Button onClick={() => void run()} loading={busy === "import"} disabled={!count}>{count > 1 ? `Import ${count}` : "Import"}</Button>}
            <Button variant="ghost" onClick={() => { setItems(null); setStatus({}); }} disabled={!!busy}>{finished ? "Import more" : "Change links"}</Button>
          </div>
        </>
      )}
    </div>
  );
}
