"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Loader2, Search } from "lucide-react";
import { Button, api } from "@/components/ui";

/** "Play" on a title that isn't in the library: ask the server to find + start the best torrent, then open the buffering screen. */
export function StartScreen() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}

function Inner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0);
  const sent = useRef(-1);

  const type = sp.get("type") === "tv" ? "tv" : "movie";
  const tmdbId = Number(sp.get("tmdbId"));
  const season = sp.get("season") ? Number(sp.get("season")) : undefined;
  const episode = sp.get("episode") ? Number(sp.get("episode")) : undefined;
  const exclude = (sp.get("exclude") ?? "").split(",").filter((h) => /^[a-fA-F0-9]{40}$/.test(h));
  const back = () => (history.length > 1 ? router.back() : router.push("/"));

  useEffect(() => {
    if (!tmdbId) { setErr("Missing title."); return; }
    if (sent.current === tries) return; // React strict mode runs effects twice in dev
    sent.current = tries;
    setErr("");
    api<{ stream: { id: string } }>("/api/ondemand/auto", { method: "POST", body: { type, tmdbId, season, episode, exclude: exclude.length ? exclude : undefined } })
      .then((r) => router.replace(`/stream/${r.stream.id}`))
      .catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tries]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <button onClick={back} className="absolute left-5 top-5 flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft className="size-4" /> Back</button>
      {err ? (
        <>
          <AlertTriangle className="size-12 text-amber-400" />
          <p className="max-w-md text-lg">{err}</p>
          <div className="flex gap-3">
            <Button onClick={() => setTries((t) => t + 1)}>Try again</Button>
            <Button variant="secondary" onClick={back}>Go back</Button>
          </div>
        </>
      ) : (
        <>
          <span className="btn-primary flex size-20 items-center justify-center rounded-2xl"><Search className="size-9 animate-pulse" /></span>
          <div>
            <h1 className="text-2xl font-bold">Finding the best source…</h1>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">Searching for a release that plays smoothly in your browser. This takes a few seconds.</p>
          </div>
          <Loader2 className="size-6 animate-spin text-muted" />
        </>
      )}
    </main>
  );
}
