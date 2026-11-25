"use client";
// First visit to Music: a few artists (and genres) to start from, optional Spotify import, and on Android the
// battery setting that keeps music playing with the screen off. Everything can be skipped and changed later.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Search, User } from "lucide-react";
import clsx from "clsx";
import { Logo } from "@/components/brand";
import { api, Button, Input } from "@/components/ui";
import { SpotifyImporter } from "@/components/music/spotify-import";
import { BackgroundPlaybackGuide, BG_TIP_KEY, isAndroid } from "@/components/music/background-playback";
import { useDebounced } from "@/lib/use-debounced";
import type { CatArtist } from "@/lib/music-types";

type Step = "artists" | "spotify" | "android";
interface Pick { id?: string | null; name: string; pictureUrl?: string | null }
interface Genre { id: string; name: string }

export function WelcomeView({ name, android }: { name: string; android: boolean }) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(android ? ["artists", "spotify", "android"] : ["artists", "spotify"]);
  const [step, setStep] = useState<Step>("artists");
  const [picked, setPicked] = useState<Pick[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (isAndroid()) setSteps(["artists", "spotify", "android"]); }, []);
  useEffect(() => { // coming back to it: start from what was picked before
    api<{ picks: { artists: Pick[]; genres: Genre[] } }>("/api/music/taste").then((r) => { setPicked(r.picks.artists); setGenres(r.picks.genres.filter((g): g is Genre => !!g.id)); }).catch(() => {});
  }, []);

  const idx = steps.indexOf(step);
  async function save(done: boolean) {
    await api("/api/music/taste", { method: "PUT", body: { artists: picked, genres, ...(done ? { onboarded: true } : {}) } });
  }
  async function next() {
    setErr("");
    try {
      if (step === "artists") await save(false);
      if (step === "android") localStorage.setItem(BG_TIP_KEY, "done");
      if (idx < steps.length - 1) { setStep(steps[idx + 1]); window.scrollTo({ top: 0 }); return; }
      setBusy(true);
      await save(true);
      router.replace("/music");
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function skipAll() {
    setBusy(true);
    try { await save(true); router.replace("/music"); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 pb-28 pt-5 sm:px-6">
      <header className="mb-8 flex items-center justify-between text-sm">
        <Logo size={24} />
        <span className="text-muted">{idx + 1} of {steps.length}</span>
        <button onClick={skipAll} disabled={busy} className="text-white/70 hover:text-white">Skip setup</button>
      </header>

      {step === "artists" && <ArtistsStep name={name} picked={picked} setPicked={setPicked} genres={genres} setGenres={setGenres} />}
      {step === "spotify" && (
        <section>
          <h1 className="text-2xl font-bold sm:text-3xl">Bring your Spotify playlists</h1>
          <p className="mb-6 mt-2 text-sm text-muted">Paste playlist links, or the link to your Spotify profile for all of its public playlists. Rift copies the song lists and plays them from your library or an on-demand source. You can also do this later under Playlists.</p>
          <SpotifyImporter />
        </section>
      )}
      {step === "android" && (
        <section>
          <h1 className="text-2xl font-bold sm:text-3xl">Keep music playing with the screen off</h1>
          <p className="mb-5 mt-2 text-sm text-muted">One setting on your phone, done once.</p>
          <BackgroundPlaybackGuide />
        </section>
      )}

      <footer className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-bg/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <span className="text-sm text-muted">
            {step === "artists" ? (picked.length ? `${picked.length} artist${picked.length === 1 ? "" : "s"}${genres.length ? `, ${genres.length} genre${genres.length === 1 ? "" : "s"}` : ""}` : "Pick a few, or skip") : err}
          </span>
          <div className="flex gap-2">
            {idx > 0 && <Button variant="ghost" onClick={() => setStep(steps[idx - 1])} disabled={busy}>Back</Button>}
            <Button onClick={next} loading={busy}>
              {step === "artists" && picked.length + genres.length === 0 ? "Skip" : idx === steps.length - 1 ? "Done" : "Next"}
            </Button>
          </div>
        </div>
        {err && step === "artists" && <p role="alert" className="mx-auto mt-1 max-w-3xl px-6 text-xs text-red-300">{err}</p>}
      </footer>
    </div>
  );
}

function ArtistsStep({ name, picked, setPicked, genres, setGenres }: { name: string; picked: Pick[]; setPicked: (f: (p: Pick[]) => Pick[]) => void; genres: Genre[]; setGenres: (f: (g: Genre[]) => Genre[]) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const [genre, setGenre] = useState<string | null>(null);
  const [list, setList] = useState<CatArtist[] | null>(null);
  const [allGenres, setAllGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    const url = term.length >= 2 ? `/api/music/taste/artists?q=${encodeURIComponent(term)}` : `/api/music/taste/artists${genre ? `?genre=${genre}` : ""}`;
    api<{ artists: CatArtist[]; genres?: Genre[] }>(url, { signal: ctl.signal })
      .then((r) => { setList(r.artists); if (r.genres?.length) setAllGenres(r.genres); setLoading(false); })
      .catch(() => { if (!ctl.signal.aborted) { setList([]); setLoading(false); } });
    return () => ctl.abort();
  }, [term, genre]);

  const isOn = (a: { name: string }) => picked.some((p) => p.name.toLowerCase() === a.name.toLowerCase());
  const toggle = (a: CatArtist) => setPicked((p) => (isOn(a) ? p.filter((x) => x.name.toLowerCase() !== a.name.toLowerCase()) : [...p, { id: a.id || null, name: a.name, pictureUrl: a.pictureUrl }].slice(0, 30)));
  const toggleGenre = (g: Genre) => {
    setGenres((cur) => (cur.some((x) => x.id === g.id) ? cur.filter((x) => x.id !== g.id) : [...cur, g].slice(0, 12)));
    setGenre((cur) => (cur === g.id ? null : g.id));
    setQ("");
  };
  // Picked artists that aren't in the current list stay visible at the front.
  const shown = [...picked.filter((p) => !(list ?? []).some((a) => a.name.toLowerCase() === p.name.toLowerCase())).map((p) => ({ id: p.id ?? "", name: p.name, pictureUrl: p.pictureUrl ?? null, fans: null })), ...(list ?? [])];

  return (
    <section>
      <h1 className="text-2xl font-bold sm:text-3xl">What do you listen to, {name}?</h1>
      <p className="mt-2 text-sm text-muted">Pick a few artists. Rift starts your home page and autoplay from them, then goes by what you actually play, like and skip.</p>

      {allGenres.length > 0 && (
        <div role="group" aria-label="Genres" className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 sm:flex-wrap">
          {allGenres.map((g) => {
            const on = genres.some((x) => x.id === g.id);
            return <button key={g.id} type="button" aria-pressed={on} onClick={() => toggleGenre(g)} className={clsx("shrink-0 rounded-full border px-3.5 py-1.5 text-sm", on ? "border-white bg-white font-semibold text-black" : "border-white/20 text-white/85 hover:border-white/50")}>{g.name}</button>;
          })}
        </div>
      )}

      <div className="relative mt-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input aria-label="Search for an artist" placeholder="Search for an artist" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
      </div>

      <div className="mt-6 grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5">
        {shown.map((a) => {
          const on = isOn(a);
          return (
            <button key={a.name} type="button" aria-pressed={on} onClick={() => toggle(a)} className="group flex min-w-0 flex-col items-center gap-2 text-center outline-none">
              <span className={clsx("relative block aspect-square w-full overflow-hidden rounded-full bg-white/5 ring-offset-2 ring-offset-bg transition", on ? "ring-2 ring-white" : "group-hover:ring-2 group-hover:ring-white/30 group-focus-visible:ring-2 group-focus-visible:ring-accent")}>
                {a.pictureUrl ? <img src={a.pictureUrl} alt="" loading="lazy" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-white/30"><User className="size-1/3" /></span>}
                {on && <span className="absolute inset-0 flex items-center justify-center bg-black/45"><Check className="size-8" /></span>}
              </span>
              <span className={clsx("w-full truncate text-sm", on ? "font-semibold text-white" : "text-white/80")}>{a.name}</span>
            </button>
          );
        })}
      </div>
      {loading && <p className="mt-4 flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" /> Loading artists…</p>}
      {!loading && list && !shown.length && <p className="mt-4 text-sm text-muted">{term ? `No artist called “${term}”.` : "No artists to suggest: the online catalogue is off and your library is empty. You can skip this step."}</p>}
    </section>
  );
}
