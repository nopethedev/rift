import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Download, Library, Play, Settings2, Zap } from "lucide-react";
import { db } from "@/server/db";
import { requireProfile } from "@/server/auth";
import { getMovie, getTv, getSeason, getRecommendations, pickTrailer, tmdbConfigured } from "@/server/tmdb";
import { annotateAvailability, showPlayTarget, tmdbToCard } from "@/server/catalog";
import { type CardItem, fmtDuration, tmdbImg } from "@/lib/types";
import { Badge, ProgressBar } from "@/components/ui";
import { Row } from "@/components/row";
import { OnDemandEpisode, TitleActions } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const t = await db.title.findFirst({ where: type === "local" ? { id } : { type: type === "tv" ? "show" : "movie", tmdbId: Number(id) || -1 } });
  return { title: t?.title ?? "Title" };
}

export default async function TitlePage({
  params, searchParams,
}: { params: Promise<{ type: string; id: string }>; searchParams: Promise<{ season?: string; play?: string }> }) {
  const { type, id } = await params;
  const sp = await searchParams;
  const { profile, user } = await requireProfile();

  if (type === "local") {
    const t = await db.title.findUnique({ where: { id } });
    if (!t?.tmdbId) notFound();
    redirect(`/title/${t.type === "show" ? "tv" : "movie"}/${t.tmdbId}`);
  }
  if (type !== "movie" && type !== "tv") notFound();
  const tmdbId = Number(id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) notFound();
  const isTv = type === "tv";

  const local = await db.title.findUnique({
    where: { type_tmdbId: { type: isTv ? "show" : "movie", tmdbId } },
    include: { files: { where: { status: "ready" }, select: { id: true, height: true, videoCodec: true, audioCodec: true } } },
  });

  if (isTv && sp.play === "1" && local) {
    const t = await showPlayTarget(local.id, profile.id);
    if (t) redirect(`/watch/${t.fileId}`);
  }

  const configured = await tmdbConfigured();
  let d: any = null;
  if (configured) d = await (isTv ? getTv(tmdbId) : getMovie(tmdbId)).catch(() => null);
  if (!d && !local) notFound();

  const title: string = d ? (isTv ? d.name : d.title) : local!.title;
  const overview: string | null = d?.overview ?? local?.overview ?? null;
  const backdrop = d?.backdrop_path ?? local?.backdropPath ?? null;
  const poster = d?.poster_path ?? local?.posterPath ?? null;
  const date: string | undefined = d ? (isTv ? d.first_air_date : d.release_date) : local?.releaseDate ?? undefined;
  const genres: string[] = d ? (d.genres ?? []).map((g: any) => g.name) : local?.genres ? JSON.parse(local.genres).map((g: any) => g.name) : [];
  const runtime: number | null = d ? (isTv ? d.episode_run_time?.[0] : d.runtime) ?? null : local?.runtime ?? null;
  const rating: number | null = d?.vote_average ?? local?.rating ?? null;
  const trailerKey = d ? pickTrailer(d.videos) : null;
  const cast: { id: number; name: string; character: string; profile_path: string | null }[] = (d?.credits?.cast ?? []).slice(0, 12);

  // Resolve what "Play" does
  let playHref: string | null = null;
  let playLabel = "Play";
  let resume: { position: number; duration: number } | null = null;
  if (local) {
    if (!isTv) {
      const f = local.files[0];
      if (f) {
        playHref = `/watch/${f.id}`;
        const p = await db.watchProgress.findUnique({ where: { profileId_mediaFileId: { profileId: profile.id, mediaFileId: f.id } } });
        if (p && !p.completed && p.positionSec > 30) { resume = { position: p.positionSec, duration: p.durationSec }; playLabel = "Resume"; }
      }
    } else {
      const t = await showPlayTarget(local.id, profile.id);
      if (t) { playHref = `/watch/${t.fileId}`; playLabel = `Play ${t.label}`; }
    }
  }

  const card: CardItem = { key: `${type}-${tmdbId}`, tmdbId, type, title, posterPath: poster, backdropPath: backdrop, available: !!playHref, localId: local?.id };

  // TV: episodes of the selected season
  let seasons: { number: number; name: string; count: number }[] = [];
  let episodes: { number: number; name: string; overview: string | null; still: string | null; runtime: number | null; air: string | null; fileId: string | null; progress: number | null }[] = [];
  let seasonNumber = 0;
  if (isTv) {
    const localSeasons = await db.season.findMany({ where: { titleId: local?.id ?? "-" }, orderBy: { number: "asc" } });
    seasons = d
      ? (d.seasons ?? []).filter((s: any) => s.season_number > 0).map((s: any) => ({ number: s.season_number, name: s.name, count: s.episode_count }))
      : localSeasons.map((s) => ({ number: s.number, name: s.name ?? `Season ${s.number}`, count: 0 }));
    const wanted = Number(sp.season);
    const localWithFiles = local ? await db.episode.findMany({ where: { titleId: local.id, files: { some: { status: "ready" } } }, orderBy: [{ season: "asc" }, { number: "asc" }], select: { season: true } }) : [];
    seasonNumber = seasons.find((s) => s.number === wanted)?.number ?? localWithFiles[0]?.season ?? seasons[0]?.number ?? 1;
    const tm: any = d ? await getSeason(tmdbId, seasonNumber).catch(() => null) : null;
    const localEps = local
      ? await db.episode.findMany({ where: { titleId: local.id, season: seasonNumber }, include: { files: { where: { status: "ready" }, take: 1, select: { id: true } } } })
      : [];
    const prog = local
      ? await db.watchProgress.findMany({ where: { profileId: profile.id, titleId: local.id, mediaFileId: { in: localEps.flatMap((e) => e.files.map((f) => f.id)) } } })
      : [];
    const byNum = new Map(localEps.map((e) => [e.number, e]));
    const merged = new Map<number, (typeof episodes)[number]>();
    for (const e of tm?.episodes ?? []) merged.set(e.episode_number, { number: e.episode_number, name: e.name, overview: e.overview, still: e.still_path, runtime: e.runtime, air: e.air_date, fileId: null, progress: null });
    for (const e of localEps) if (!merged.has(e.number)) merged.set(e.number, { number: e.number, name: e.name ?? `Episode ${e.number}`, overview: e.overview, still: e.stillPath, runtime: e.runtime, air: e.airDate, fileId: null, progress: null });
    episodes = [...merged.values()].sort((a, b) => a.number - b.number).map((e) => {
      const fid = byNum.get(e.number)?.files[0]?.id ?? null;
      const p = prog.find((x) => x.mediaFileId === fid);
      return { ...e, fileId: fid, progress: p ? (p.completed ? 1 : p.durationSec ? p.positionSec / p.durationSec : 0) : null };
    });
  }

  let similar: CardItem[] = [];
  if (configured) {
    similar = await getRecommendations(isTv ? "tv" : "movie", tmdbId)
      .then((r: any) => annotateAvailability((r.results ?? []).map((x: any) => tmdbToCard(x, type)).filter((c: CardItem | null): c is CardItem => !!c && !!c.posterPath)))
      .catch(() => []);
  }

  const bgUrl = tmdbImg(backdrop, "original");
  return (
    <>
      <div className="relative h-[58vh] min-h-[380px] w-full overflow-hidden sm:h-[68vh]">
        {bgUrl && <img src={bgUrl} alt="" className="size-full object-cover object-top" />}
        <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/60 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-bg to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-4 pb-8 sm:px-12">
          <div className="max-w-3xl space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {playHref ? <Badge tone="accent"><Library className="size-3" /> In your library</Badge> : <Badge>Not in your library</Badge>}
              <Badge>{isTv ? "Series" : "Movie"}</Badge>
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight drop-shadow-lg sm:text-6xl">{title}</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-white/80">
              {rating ? <span className="font-semibold text-emerald-400">{Math.round(rating * 10)}% match</span> : null}
              {date && <span>{date.slice(0, 4)}</span>}
              {runtime ? <span>{fmtDuration(runtime * 60)}</span> : null}
              {isTv && d?.number_of_seasons ? <span>{d.number_of_seasons} season{d.number_of_seasons > 1 ? "s" : ""}</span> : null}
              {genres.length > 0 && <span className="text-white/60">{genres.join(" • ")}</span>}
            </div>
            <TitleActions card={card} playHref={playHref} playLabel={playLabel} trailerKey={trailerKey} resumeFraction={resume ? resume.position / (resume.duration || 1) : null} stream={isTv ? { season: seasonNumber ?? 1, episode: episodes[0]?.number ?? 1 } : undefined} />
            {!playHref && (
              <p className="text-sm text-muted">
                This title is not in your library yet.
                {user.role === "ADMIN" && (
                  <Link href={`/admin/media/new?tmdbId=${tmdbId}&type=${type}`} className="ml-2 inline-flex items-center gap-1 py-2.5 font-semibold text-violet-300 hover:underline pointer-fine:py-0"><Download className="size-3.5" /> Add to library</Link>
                )}
                {user.role === "ADMIN" && (
                  <Link href={`/admin/media/new?tmdbId=${tmdbId}&type=${type}&source=torrent`} className="ml-3 inline-flex items-center gap-1 py-2.5 font-semibold text-violet-300 hover:underline pointer-fine:py-0"><Zap className="size-3.5" /> Stream via torrent</Link>
                )}
              </p>
            )}
            {user.role === "ADMIN" && local && <Link href="/admin/media" className="inline-flex items-center gap-1 text-xs text-muted hover:text-white"><Settings2 className="size-3.5" /> Manage in admin</Link>}
          </div>
        </div>
      </div>

      <div className="grid gap-10 px-4 py-8 sm:px-12 lg:grid-cols-[1fr_320px]">
        <div className="space-y-10">
          {overview && <p className="max-w-3xl text-base leading-relaxed text-white/85">{overview}</p>}
          {resume && <div className="max-w-md"><p className="mb-1 text-xs text-muted">Resume from {fmtDuration(resume.position)}</p><ProgressBar value={resume.position / (resume.duration || 1)} /></div>}

          {isTv && seasons.length > 0 && (
            <section>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="mr-3 text-xl font-semibold">Episodes</h2>
                {seasons.map((s) => (
                  <Link key={s.number} replace scroll={false} href={`/title/tv/${tmdbId}?season=${s.number}`} className={`rounded-full px-4 py-2 text-sm transition pointer-fine:px-3.5 pointer-fine:py-1 ${s.number === seasonNumber ? "bg-accent text-white" : "bg-white/10 hover:bg-white/20"}`}>S{s.number}</Link>
                ))}
              </div>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {episodes.map((e) => {
                  const body = (
                    <>
                      <span className="w-6 shrink-0 text-center text-lg text-white/50">{e.number}</span>
                      <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-surface-2 sm:w-40">
                        {e.still && <img src={tmdbImg(e.still, "w342")!} alt="" loading="lazy" className="size-full object-cover" />}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100"><Play className="size-7 fill-white" /></span>
                        {e.progress ? <div className="absolute inset-x-0 bottom-0"><ProgressBar value={e.progress} className="h-1 rounded-none" /></div> : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate font-semibold">{e.name}</p>
                          <span className="shrink-0 text-xs text-muted">{e.runtime ? `${e.runtime}m` : ""}</span>
                        </div>
                        <p className="line-clamp-2 text-sm text-white/60">{e.overview}</p>
                        {!e.fileId && <span className="mt-1 inline-block text-[11px] uppercase tracking-wide text-white/40">Not in library</span>}
                      </div>
                    </>
                  );
                  return (
                    <li key={e.number}>
                      {e.fileId ? (
                        <Link href={`/watch/${e.fileId}`} className="group flex items-center gap-3 p-3 transition hover:bg-white/5">{body}</Link>
                      ) : (
                        <OnDemandEpisode tmdbId={tmdbId} season={seasonNumber ?? 1} episode={e.number}>{body}</OnDemandEpisode>
                      )}
                    </li>
                  );
                })}
                {!episodes.length && <li className="p-6 text-center text-sm text-muted">No episode information available.</li>}
              </ul>
            </section>
          )}
        </div>

        <aside className="space-y-6 text-sm">
          {poster && <img src={tmdbImg(poster, "w500")!} alt="" className="hidden w-48 rounded-xl shadow-2xl lg:block" />}
          {cast.length > 0 && (
            <div>
              <h3 className="mb-2 font-semibold text-white/80">Cast</h3>
              <ul className="space-y-2">
                {cast.map((c) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <span className="size-9 shrink-0 overflow-hidden rounded-full bg-surface-2">{c.profile_path && <img src={tmdbImg(c.profile_path, "w185")!} alt="" loading="lazy" className="size-full object-cover" />}</span>
                    <span className="min-w-0"><span className="block truncate">{c.name}</span><span className="block truncate text-xs text-muted">{c.character}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {similar.length > 0 && <div className="pb-6"><Row title="More like this" items={similar} /></div>}
    </>
  );
}
