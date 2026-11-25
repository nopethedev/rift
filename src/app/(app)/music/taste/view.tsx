"use client";
import Link from "next/link";
import { usePoll } from "@/lib/use-poll";
import { Skeleton } from "@/components/ui";

interface Taste {
  artists: { name: string; score: number }[]; genres: { name: string; score: number }[]; decades: { decade: number; score: number }[];
  learned: number; signals: number; picks: { artists: { name: string }[]; genres: { name: string }[] };
}

function Bars({ rows }: { rows: { label: string; score: number; href?: string }[] }) {
  return (
    <ol className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 text-sm">
          {r.href ? <Link href={r.href} className="truncate hover:underline">{r.label}</Link> : <span className="truncate">{r.label}</span>}
          <span className="h-1.5 rounded-full bg-white/10"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, r.score * 100)}%` }} /></span>
        </li>
      ))}
    </ol>
  );
}

/** What Rift has learned about this profile, and where it came from. */
export function TasteView() {
  const { data, loading } = usePoll<Taste>("/api/music/taste");
  if (loading || !data) return <Skeleton className="h-64" />;
  const pct = Math.round(data.learned * 100);
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold">Your music taste</h1>
      <p className="mt-1 text-sm text-muted">
        {data.signals === 0 && !data.picks.artists.length
          ? "Nothing yet. Play some music, like songs or build playlists, and this fills in."
          : `Built from ${data.signals} plays, likes and playlist songs${data.picks.artists.length ? ` and ${data.picks.artists.length} artists you picked` : ""}. ${pct >= 100 ? "It now goes by what you play." : `About ${pct}% of it comes from listening so far; the rest from your picks.`}`}
        {" "}It decides “Made for you”, autoplay and the suggestions under playlists. Finished songs count most, skips count against a song, and older listening slowly fades.
      </p>
      <div className="mt-8 grid gap-10 sm:grid-cols-2">
        <section><h2 className="mb-3 font-semibold">Artists</h2>{data.artists.length ? <Bars rows={data.artists.slice(0, 15).map((a) => ({ label: a.name, score: a.score, href: `/music/artists/${encodeURIComponent(a.name)}` }))} /> : <p className="text-sm text-muted">None yet.</p>}</section>
        <div className="space-y-10">
          <section><h2 className="mb-3 font-semibold">Genres</h2>{data.genres.length ? <Bars rows={data.genres.map((g) => ({ label: g.name, score: g.score }))} /> : <p className="text-sm text-muted">Comes from your library&apos;s genre tags and the genres you pick.</p>}</section>
          {data.decades.length > 0 && <section><h2 className="mb-3 font-semibold">Decades</h2><Bars rows={data.decades.map((d) => ({ label: `${d.decade}s`, score: d.score }))} /></section>}
        </div>
      </div>
      <div className="mt-10 border-t border-white/10 pt-5 text-sm">
        <p className="text-muted">Picked at the start: {data.picks.artists.length ? data.picks.artists.map((a) => a.name).join(", ") : "nothing"}{data.picks.genres.length ? ` · ${data.picks.genres.map((g) => g.name).join(", ")}` : ""}</p>
        <Link href="/music/welcome" className="mt-2 inline-block font-semibold text-violet-300 hover:underline">Change your picks</Link>
      </div>
    </div>
  );
}
