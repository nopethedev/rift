import "server-only";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { env } from "./config";
import { HttpError } from "./api";
import { getSettings } from "./settings";
import { registerSubtitleFile } from "./library/importer";
import { OpenSubtitles, OpenSubtitlesError, type OsQuery, type OsResult, openSubtitlesHash } from "./opensubtitles";

/** One client per credential set, so the login token is reused between requests. */
let client: { sig: string; os: OpenSubtitles } | null = null;

export async function getOpenSubtitles(): Promise<OpenSubtitles> {
  const s = await getSettings();
  if (!s.opensubtitlesApiKey) throw new HttpError(503, "OpenSubtitles is not configured. Add your API key in Admin → Settings → Subtitles.");
  const sig = [s.opensubtitlesApiKey, s.opensubtitlesUsername, s.opensubtitlesPassword, env.opensubtitlesBase].join("\0");
  if (client?.sig !== sig) client = { sig, os: new OpenSubtitles({ apiKey: s.opensubtitlesApiKey, username: s.opensubtitlesUsername, password: s.opensubtitlesPassword, baseUrl: env.opensubtitlesBase }) };
  return client.os;
}

/** Run an OpenSubtitles call and turn its errors into API errors. */
export async function osCall<T>(fn: (os: OpenSubtitles) => Promise<T>): Promise<T> {
  try {
    return await fn(await getOpenSubtitles());
  } catch (e) {
    if (e instanceof OpenSubtitlesError) throw new HttpError(e.status === 429 ? 429 : 502, e.message);
    throw e;
  }
}

const languageName = (code: string) => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; } };

async function loadFile(mediaFileId: string) {
  const f = await db.mediaFile.findUnique({ where: { id: mediaFileId }, include: { title: true, episode: { include: { titleRef: true } }, subtitles: { select: { language: true } } } });
  if (!f) throw new HttpError(404, "File not found");
  return f;
}

/** Build the search for a library file: TMDB ids (+ season/episode) and the file hash for exact release matches. */
export async function queryForFile(mediaFileId: string, languages: string[], text?: string): Promise<OsQuery> {
  const f = await loadFile(mediaFileId);
  const show = f.episode?.titleRef;
  const t = show ?? f.title;
  const q: OsQuery = f.episode
    ? { type: "episode", tmdbId: show?.tmdbId ?? undefined, season: f.episode.season, episode: f.episode.number, languages }
    : { type: "movie", tmdbId: f.title?.tmdbId ?? undefined, languages, year: f.title?.year ?? undefined };
  if (text?.trim()) { q.query = text.trim(); q.tmdbId = undefined; } // manual query overrides the TMDB lookup
  else if (!q.tmdbId) q.query = t?.title ?? path.basename(f.path, path.extname(f.path)).replace(/[._]+/g, " ");
  if (q.type === "episode" && q.query && !q.tmdbId) q.query = `${q.query}`; // season/episode params still narrow it down
  try { q.moviehash = (await openSubtitlesHash(f.path)) ?? undefined; } catch { /* file offline: search without hash */ }
  return q;
}

export async function searchForFile(mediaFileId: string, languages: string[], text?: string): Promise<OsResult[]> {
  const q = await queryForFile(mediaFileId, languages, text);
  return osCall((os) => os.search(q));
}

/** Download one subtitle, convert it to WebVTT and attach it to the media file. */
export async function attachSubtitle(mediaFileId: string, osFileId: number, language: string, release?: string, hearingImpaired = false) {
  await loadFile(mediaFileId);
  const dl = await osCall((os) => os.download(osFileId));
  const tmpDir = path.join(env.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${randomUUID()}.srt`);
  await writeFile(tmp, dl.content);
  try {
    const label = `${languageName(language)}${hearingImpaired ? " (SDH)" : ""}${release ? ` · ${release.slice(0, 40)}` : ""}`;
    const sub = await registerSubtitleFile(mediaFileId, tmp, { language, label, source: "opensubtitles" });
    return { subtitle: sub, remaining: dl.remaining };
  } catch (e) {
    throw new HttpError(422, `Could not convert subtitle: ${(e as Error).message}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface AutoReport { added: number; skipped: number; notFound: number; errors: string[] }

/** Fetch the best subtitle for every preferred language that a title's files are missing (sequential: friendly to the API's rate limit). */
export async function autoFetchForTitle(titleId: string, maxDownloads = 30): Promise<AutoReport> {
  const s = await getSettings();
  const t = await db.title.findUnique({ where: { id: titleId }, include: { files: { where: { status: "ready" }, select: { id: true } }, episodes: { include: { files: { where: { status: "ready" }, select: { id: true } } } } } });
  if (!t) throw new HttpError(404, "Title not found");
  const ids = [...t.files, ...t.episodes.flatMap((e) => e.files)].map((f) => f.id);
  const report: AutoReport = { added: 0, skipped: 0, notFound: 0, errors: [] };
  for (const id of ids) {
    const have = new Set((await db.subtitle.findMany({ where: { mediaFileId: id }, select: { language: true } })).map((x) => (x.language ?? "").slice(0, 2).toLowerCase()));
    for (const lang of s.subtitleLanguages) {
      if (have.has(lang.slice(0, 2).toLowerCase())) { report.skipped++; continue; }
      if (report.added >= maxDownloads) return report;
      try {
        const results = await searchForFile(id, [lang]);
        const best = results.find((r) => !r.hearingImpaired) ?? results[0];
        if (!best) { report.notFound++; continue; }
        await attachSubtitle(id, best.fileId, lang, best.release, best.hearingImpaired);
        report.added++;
        await new Promise((r) => setTimeout(r, 400));
      } catch (e) {
        report.errors.push((e as Error).message);
        if (e instanceof HttpError && (e.status === 429 || e.status === 503)) return report; // quota / config problem: stop early
      }
    }
  }
  return report;
}
