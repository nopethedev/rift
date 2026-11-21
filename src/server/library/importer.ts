import "server-only";
import { randomUUID } from "node:crypto";
import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/server/db";
import { paths } from "@/server/config";
import { getSettings } from "@/server/settings";
import { searchMovie, searchTv, tmdbConfigured } from "@/server/tmdb";
import { ensureEpisode, ensureMovieTitle, ensureShowTitle } from "@/server/library-titles";
import { firstAudio, firstVideo, probeFile, type ProbeResult } from "@shared/probe";
import {
  convertSubtitleFileToVtt,
  extractEmbeddedSubtitleToVtt,
  guessSubtitleLanguage,
  SUBTITLE_EXTENSIONS,
  subtitleFormatOf,
} from "@shared/subtitles";
import type { MediaFile, Subtitle } from "@/generated/prisma/client";
import { isSampleFile, isVideoFile, parseMediaFilename, titleSimilarity, type ParsedMediaName } from "./filename";

export class ImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ImportError";
  }
}

export type ImportSource = "upload" | "import" | "torrent";

export interface ImportHint {
  tmdbId: number;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
}

export interface ImportMatch {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  titleId: string;
  season?: number;
  episode?: number;
  episodeId?: string;
  /** "hint" when linked from an explicit hint, otherwise the TMDB match confidence 0..1. */
  confidence: number | "hint";
}

export interface ImportResult {
  mediaFileId: string;
  path: string;
  created: boolean;
  status: "ready" | "unmatched";
  match: ImportMatch | null;
  parsed: ParsedMediaName;
  subtitles: number;
  warnings: string[];
}

export interface ScanProgress {
  dir: string;
  total: number;
  done: number;
  current?: string;
}

export interface ScanReport {
  dir: string;
  found: number;
  imported: number;
  matched: number;
  unmatched: number;
  skippedExisting: number;
  skippedInProgress: number;
  restored: number;
  errors: { path: string; error: string }[];
  startedAt: string;
  durationMs: number;
}

const MATCH_THRESHOLD = 0.78;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const IGNORED_DIRS = new Set(["@eaDir", "lost+found", "$RECYCLE.BIN", "System Volume Information", ".Trash", ".Trashes"]);
const PARTIAL_EXT = /\.(part|partial|!qb|!ut|crdownload|tmp|temp|download)$/i;

// ---------------------------------------------------------------------------------------------- helpers

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Path relative to the library root that contains the file (gives the parser folder context). */
async function contextPath(abs: string): Promise<string> {
  const s = await getSettings().catch(() => null);
  const roots = [...(s?.libraryDirs ?? []), s?.downloadDir, s?.uploadDir].filter((d): d is string => !!d).map((d) => path.resolve(d));
  let best: string | null = null;
  for (const r of roots) {
    if (abs.startsWith(r + path.sep) && (!best || r.length > best.length)) best = r;
  }
  if (best) return path.relative(best, abs);
  return abs.split(path.sep).slice(-3).join("/");
}

const yearOf = (d?: string | null) => (d && d.length >= 4 ? Number(d.slice(0, 4)) || undefined : undefined);

interface TmdbCandidate {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

function scoreCandidate(parsed: ParsedMediaName, c: TmdbCandidate, kind: "movie" | "tv"): number {
  const names = kind === "movie" ? [c.title, c.original_title] : [c.name, c.original_name];
  let sim = 0;
  for (const n of names) if (n) sim = Math.max(sim, titleSimilarity(parsed.title, n));
  const y = yearOf(kind === "movie" ? c.release_date : c.first_air_date);
  if (parsed.year && y) {
    const d = Math.abs(parsed.year - y);
    if (d === 0) sim += 0.1;
    else if (d === 1) sim += 0.03;
    else if (kind === "movie") sim -= 0.25;
    else sim -= 0.05; // a show's later season can be years after first air date
  }
  return sim;
}

/** Find the best TMDB match for a parsed filename, or null below the confidence threshold. */
async function identify(parsed: ParsedMediaName): Promise<{ kind: "movie" | "tv"; id: number; confidence: number } | null> {
  if (!parsed.title || parsed.title.length < 1) return null;
  const kind = parsed.kind === "episode" ? "tv" : "movie";
  const search = (year?: number) => (kind === "movie" ? searchMovie(parsed.title, year) : searchTv(parsed.title, year));
  let results: TmdbCandidate[] = ((await search(parsed.year)) as { results?: TmdbCandidate[] }).results ?? [];
  if (!results.length && parsed.year) results = ((await search(undefined)) as { results?: TmdbCandidate[] }).results ?? [];
  let best: { id: number; score: number; pop: number } | null = null;
  for (const c of results.slice(0, 20)) {
    const score = scoreCandidate(parsed, c, kind);
    const pop = c.popularity ?? 0;
    if (!best || score > best.score + 0.001 || (Math.abs(score - best.score) <= 0.001 && pop > best.pop)) best = { id: c.id, score, pop };
  }
  if (!best || best.score < MATCH_THRESHOLD) return null;
  return { kind, id: best.id, confidence: Math.min(1, Math.round(best.score * 100) / 100) };
}

async function movieTitle(tmdbId: number) {
  try {
    return await ensureMovieTitle(tmdbId);
  } catch (e) {
    const local = await db.title.findUnique({ where: { type_tmdbId: { type: "movie", tmdbId } } });
    if (local) return local;
    throw e;
  }
}

async function showTitle(tmdbId: number) {
  try {
    return await ensureShowTitle(tmdbId);
  } catch (e) {
    const local = await db.title.findUnique({ where: { type_tmdbId: { type: "show", tmdbId } } });
    if (local) return local;
    throw e;
  }
}

function probeColumns(p: ProbeResult) {
  const v = firstVideo(p);
  const a = firstAudio(p);
  return {
    container: p.container,
    durationSec: p.durationSec || null,
    videoCodec: v?.codec ?? null,
    audioCodec: a?.codec ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    bitrate: p.bitrate ? Math.round(p.bitrate) : null,
    probe: JSON.stringify(p),
  };
}

/** Quality rank used to decide which file of an episode stays linked. */
const quality = (f: Pick<MediaFile, "height" | "size" | "createdAt">) => [f.height ?? 0, Number(f.size)] as const;
const better = (a: readonly number[], b: readonly number[]) => a[0] !== b[0] ? a[0] > b[0] : a[1] >= b[1];

/**
 * Link a file to an episode. Only one file per episode stays linked: the best one (higher resolution, then larger;
 * ties go to the newer file). The other one becomes "unmatched" so the admin can see / delete it.
 */
async function linkEpisodeFile(file: MediaFile, episodeId: string, warnings: string[]): Promise<boolean> {
  const others = await db.mediaFile.findMany({ where: { episodeId, id: { not: file.id }, status: "ready" } });
  let keep = true;
  for (const o of others) {
    if (!(await exists(o.path))) {
      await db.mediaFile.update({ where: { id: o.id }, data: { status: "missing" } });
      continue;
    }
    if (better(quality(file), quality(o))) {
      await db.mediaFile.update({ where: { id: o.id }, data: { episodeId: null, status: "unmatched", rawName: o.rawName ?? path.basename(o.path) } });
      warnings.push(`Replaced ${path.basename(o.path)} as the file for this episode`);
    } else {
      keep = false;
      warnings.push(`A better file is already linked to this episode (${path.basename(o.path)}); left unmatched`);
    }
  }
  if (keep) await db.mediaFile.update({ where: { id: file.id }, data: { episodeId, titleId: null, status: "ready", rawName: null } });
  else await db.mediaFile.update({ where: { id: file.id }, data: { episodeId: null, titleId: null, status: "unmatched", rawName: path.basename(file.path) } });
  return keep;
}

async function applyMatch(
  file: MediaFile,
  target: { tmdbId: number; mediaType: "movie" | "tv"; season?: number; episode?: number },
  confidence: number | "hint",
  warnings: string[],
): Promise<ImportMatch | null> {
  if (target.mediaType === "movie") {
    const t = await movieTitle(target.tmdbId);
    await db.mediaFile.update({ where: { id: file.id }, data: { titleId: t.id, episodeId: null, status: "ready", rawName: null } });
    return { tmdbId: target.tmdbId, mediaType: "movie", title: t.title, titleId: t.id, confidence };
  }
  if (target.episode === undefined || target.episode === null) {
    warnings.push("Could not determine the episode number from the file name");
    return null;
  }
  const season = target.season ?? 1;
  const show = await showTitle(target.tmdbId);
  const ep = await ensureEpisode(show.id, target.tmdbId, season, target.episode);
  const linked = await linkEpisodeFile(file, ep.id, warnings);
  if (!linked) return null;
  return { tmdbId: target.tmdbId, mediaType: "tv", title: show.title, titleId: show.id, season, episode: target.episode, episodeId: ep.id, confidence };
}

// ---------------------------------------------------------------------------------------------- subtitles

const LANG_LABELS: Record<string, string> = {
  en: "English", eng: "English", es: "Spanish", spa: "Spanish", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German",
  it: "Italian", ita: "Italian", pt: "Portuguese", por: "Portuguese", ru: "Russian", rus: "Russian", ja: "Japanese", jpn: "Japanese", ko: "Korean",
  kor: "Korean", zh: "Chinese", chi: "Chinese", zho: "Chinese", nl: "Dutch", dut: "Dutch", nld: "Dutch", pl: "Polish", pol: "Polish", tr: "Turkish",
  tur: "Turkish", ar: "Arabic", ara: "Arabic", sv: "Swedish", swe: "Swedish",
};
const langLabel = (l?: string) => (l ? LANG_LABELS[l.toLowerCase()] ?? l.toUpperCase() : undefined);

/** Convert a subtitle file to WebVTT under data/subtitles/<mediaFileId>/ and register it. */
export async function registerSubtitleFile(
  mediaFileId: string,
  srcPath: string,
  opts: { language?: string; label?: string; source?: "external" | "embedded" | "upload" | "opensubtitles"; isDefault?: boolean } = {},
): Promise<Subtitle> {
  const fmt = subtitleFormatOf(srcPath);
  if (!fmt) throw new ImportError(`Unsupported subtitle format: ${path.extname(srcPath) || "(none)"}`, 415);
  const file = await db.mediaFile.findUnique({ where: { id: mediaFileId }, select: { id: true } });
  if (!file) throw new ImportError("Media file not found", 404);
  const out = path.join(paths.subtitles, mediaFileId, `${randomUUID()}.vtt`);
  try {
    await convertSubtitleFileToVtt(srcPath, out);
  } catch (e) {
    await rm(out, { force: true }).catch(() => {});
    throw new ImportError(`Could not convert subtitle ${path.basename(srcPath)}: ${errMsg(e)}`, 422);
  }
  const language = opts.language ?? guessSubtitleLanguage(srcPath);
  const forced = /[.\-_ ]forced([.\-_ ]|$)/i.test(path.basename(srcPath, path.extname(srcPath)));
  const sdh = /[.\-_ ](sdh|cc|hi)([.\-_ ]|$)/i.test(path.basename(srcPath, path.extname(srcPath)));
  const label =
    opts.label ??
    ([langLabel(language), forced ? "Forced" : null, sdh ? "SDH" : null].filter(Boolean).join(" ") || path.basename(srcPath, path.extname(srcPath)));
  return db.subtitle.create({
    data: { mediaFileId, language: language ?? null, label, format: fmt, path: out, source: opts.source ?? "external", isDefault: !!opts.isDefault },
  });
}

/** Sidecar subtitles: "<stem>*.srt|vtt|ass|ssa" next to the file and inside a Subs/ or Subtitles/ folder. */
async function findSidecarSubtitles(videoPath: string): Promise<string[]> {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const isSub = (n: string) => SUBTITLE_EXTENSIONS.includes(path.extname(n).toLowerCase());
  const found = new Set<string>();
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const videosHere = entries.filter((e) => e.isFile() && isVideoFile(e.name) && !isSampleFile(e.name)).length;
  for (const e of entries) {
    if (e.isFile() && isSub(e.name) && e.name.toLowerCase().startsWith(stem)) found.add(path.join(dir, e.name));
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^(subs?|subtitles?)$/i.test(e.name)) continue;
    const subDir = path.join(dir, e.name);
    let inner: import("node:fs").Dirent[] = [];
    try {
      inner = await readdir(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      const p = path.join(subDir, f.name);
      if (f.isFile() && isSub(f.name)) {
        // a single-video folder (movie) owns every subtitle in Subs/; packs only the ones named like the episode
        if (videosHere <= 1 || f.name.toLowerCase().startsWith(stem)) found.add(p);
      } else if (f.isDirectory() && f.name.toLowerCase() === stem) {
        // TV packs: Subs/<episode file stem>/2_English.srt
        try {
          for (const g of await readdir(p, { withFileTypes: true })) if (g.isFile() && isSub(g.name)) found.add(path.join(p, g.name));
        } catch { /* ignore */ }
      }
    }
  }
  return [...found].sort();
}

/** (Re)attach sidecar + embedded text subtitles. Never throws. */
async function attachSubtitles(file: MediaFile, probe: ProbeResult | null, warnings: string[]): Promise<number> {
  let count = 0;
  try {
    // re-import: drop previously auto-detected tracks (uploads are kept)
    const old = await db.subtitle.findMany({ where: { mediaFileId: file.id, source: { in: ["external", "embedded"] } } });
    for (const s of old) await rm(s.path, { force: true }).catch(() => {});
    if (old.length) await db.subtitle.deleteMany({ where: { id: { in: old.map((s) => s.id) } } });
  } catch (e) {
    warnings.push(`Could not clean old subtitles: ${errMsg(e)}`);
  }
  try {
    for (const p of await findSidecarSubtitles(file.path)) {
      try {
        const lang = guessSubtitleLanguage(p) ?? guessSubtitleLanguage(p.replace(/^.*[\\/]\d+_/, "x."));
        await registerSubtitleFile(file.id, p, { source: "external", language: lang });
        count++;
      } catch (e) {
        warnings.push(errMsg(e));
      }
    }
  } catch (e) {
    warnings.push(`Sidecar subtitle lookup failed: ${errMsg(e)}`);
  }
  for (const s of probe?.streams ?? []) {
    if (s.type !== "subtitle" || !s.textBased) continue;
    const out = path.join(paths.subtitles, file.id, `embedded-${s.index}.vtt`);
    try {
      await extractEmbeddedSubtitleToVtt(file.path, s.index, out);
      const label = [s.title || langLabel(s.language) || `Track ${s.index}`, s.forced && !/forced/i.test(s.title ?? "") ? "Forced" : null].filter(Boolean).join(" ");
      await db.subtitle.create({
        data: { mediaFileId: file.id, language: s.language ?? null, label, format: "embedded", path: out, source: "embedded", isDefault: !!s.default && !!s.forced },
      });
      count++;
    } catch (e) {
      await rm(out, { force: true }).catch(() => {});
      warnings.push(`Embedded subtitle #${s.index} could not be extracted: ${errMsg(e)}`);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------------------------- import

/**
 * Probe a video file, create/update its MediaFile row, identify it (hint > existing link > filename + TMDB)
 * and attach subtitles. Throws ImportError only when the file itself is unusable.
 */
export async function importFile(absPath: string, opts: { source: ImportSource; hint?: ImportHint }): Promise<ImportResult> {
  const abs = path.resolve(absPath);
  const warnings: string[] = [];
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new ImportError(`File not found: ${abs}`, 404);
  }
  if (!st.isFile()) throw new ImportError(`Not a file: ${abs}`, 400);
  if (!isVideoFile(abs)) throw new ImportError(`Not a supported video file: ${path.basename(abs)}`, 415);

  let probe: ProbeResult;
  try {
    probe = await probeFile(abs);
  } catch (e) {
    throw new ImportError(`Could not read media file ${path.basename(abs)}: ${errMsg(e).split("\n")[0]}`, 422);
  }
  if (!probe.streams.some((s) => s.type === "video")) throw new ImportError(`${path.basename(abs)} has no video stream`, 422);

  const existing = await db.mediaFile.findUnique({ where: { path: abs } });
  const columns = { ...probeColumns(probe), size: BigInt(st.size) };
  const file = existing
    ? await db.mediaFile.update({ where: { id: existing.id }, data: { ...columns, status: existing.status === "missing" ? (existing.titleId || existing.episodeId ? "ready" : "unmatched") : existing.status } })
    : await db.mediaFile.create({ data: { ...columns, path: abs, source: opts.source, status: "unmatched", rawName: path.basename(abs) } });

  const parsed = parseMediaFilename(await contextPath(abs));
  let match: ImportMatch | null = null;

  try {
    if (opts.hint) {
      const h = opts.hint;
      const target =
        h.mediaType === "movie"
          ? { tmdbId: h.tmdbId, mediaType: "movie" as const }
          : {
              tmdbId: h.tmdbId,
              mediaType: "tv" as const,
              season: h.season ?? (parsed.kind === "episode" ? parsed.season : undefined),
              episode: h.episode ?? (parsed.kind === "episode" ? parsed.episode : undefined),
            };
      match = await applyMatch(file, target, "hint", warnings);
    } else if (existing && (existing.titleId || existing.episodeId) && existing.status !== "unmatched") {
      // keep an earlier (possibly manual) match on re-import
      const t = existing.titleId
        ? await db.title.findUnique({ where: { id: existing.titleId } })
        : null;
      const ep = existing.episodeId ? await db.episode.findUnique({ where: { id: existing.episodeId }, include: { titleRef: true } }) : null;
      const title = t ?? ep?.titleRef ?? null;
      if (title) {
        match = {
          tmdbId: title.tmdbId ?? 0, mediaType: title.type === "show" ? "tv" : "movie", title: title.title, titleId: title.id,
          season: ep?.season, episode: ep?.number, episodeId: ep?.id, confidence: "hint",
        };
        await db.mediaFile.update({ where: { id: file.id }, data: { status: "ready" } });
      }
    } else if (!(await tmdbConfigured())) {
      warnings.push("TMDB is not configured; the file was imported as unmatched");
    } else {
      const hit = await identify(parsed);
      if (!hit) warnings.push(`No confident TMDB match for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ""}`);
      else
        match = await applyMatch(
          file,
          hit.kind === "movie" ? { tmdbId: hit.id, mediaType: "movie" } : { tmdbId: hit.id, mediaType: "tv", season: parsed.season, episode: parsed.episode },
          hit.confidence,
          warnings,
        );
    }
  } catch (e) {
    warnings.push(`Identification failed: ${errMsg(e)}`);
    match = null;
  }

  if (!match) {
    const cur = await db.mediaFile.findUnique({ where: { id: file.id } });
    if (cur && cur.status !== "ready") {
      await db.mediaFile.update({ where: { id: file.id }, data: { status: "unmatched", rawName: cur.rawName ?? path.basename(abs) } });
    } else if (cur && cur.status === "ready" && !cur.titleId && !cur.episodeId) {
      await db.mediaFile.update({ where: { id: file.id }, data: { status: "unmatched", rawName: path.basename(abs) } });
    }
  }

  const subtitles = await attachSubtitles(file, probe, warnings);
  const final = await db.mediaFile.findUnique({ where: { id: file.id } });
  return {
    mediaFileId: file.id,
    path: abs,
    created: !existing,
    status: final?.status === "ready" ? "ready" : "unmatched",
    match,
    parsed,
    subtitles,
    warnings,
  };
}

/** Manually (re)match a file. For TV without season/episode the filename is parsed. */
export async function linkMediaFile(mediaFileId: string, target: { tmdbId: number; mediaType: "movie" | "tv"; season?: number; episode?: number }): Promise<ImportResult> {
  const file = await db.mediaFile.findUnique({ where: { id: mediaFileId } });
  if (!file) throw new ImportError("Media file not found", 404);
  const parsed = parseMediaFilename(await contextPath(file.path));
  const warnings: string[] = [];
  const t =
    target.mediaType === "movie"
      ? { tmdbId: target.tmdbId, mediaType: "movie" as const }
      : {
          tmdbId: target.tmdbId,
          mediaType: "tv" as const,
          season: target.season ?? (parsed.kind === "episode" ? parsed.season : undefined),
          episode: target.episode ?? (parsed.kind === "episode" ? parsed.episode : undefined),
        };
  if (t.mediaType === "tv" && t.episode === undefined) throw new ImportError("Season and episode numbers are required for this file", 400);
  let match: ImportMatch | null;
  try {
    match = await applyMatch(file, t, "hint", warnings);
  } catch (e) {
    throw new ImportError(`Could not load metadata from TMDB: ${errMsg(e)}`, 502);
  }
  const final = await db.mediaFile.findUnique({ where: { id: file.id } });
  return {
    mediaFileId: file.id, path: file.path, created: false, status: final?.status === "ready" ? "ready" : "unmatched",
    match, parsed, subtitles: await db.subtitle.count({ where: { mediaFileId: file.id } }), warnings,
  };
}

// ---------------------------------------------------------------------------------------------- scanning

/** Absolute paths of files that belong to downloads which are not finished/imported yet. */
async function downloadFilesInProgress(): Promise<Set<string>> {
  const s = await getSettings();
  const skip = ["queued", "metadata", "downloading", "paused", "importing", "error", "seeding"];
  if (s.autoImportDownloads) skip.push("completed"); // the hinted import will pick them up
  const rows = await db.download.findMany({ where: { status: { in: skip } }, select: { savePath: true, files: true } });
  const out = new Set<string>();
  for (const r of rows) {
    const base = path.dirname(r.savePath);
    let files: { path: string }[] = [];
    try {
      files = JSON.parse(r.files ?? "[]");
    } catch { /* ignore */ }
    for (const f of files) out.add(path.resolve(base, f.path));
    out.add(path.resolve(r.savePath)); // single-file torrents
  }
  return out;
}

async function walkVideos(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [path.resolve(root)];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile() && isVideoFile(e.name) && !PARTIAL_EXT.test(e.name) && !isSampleFile(path.relative(root, p))) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

/** True when the file still seems to be written (recent mtime and growing). */
async function isBeingWritten(p: string): Promise<boolean> {
  try {
    const a = await stat(p);
    if (a.size === 0) return true;
    if (Date.now() - a.mtimeMs > 60_000) return false;
    await new Promise((r) => setTimeout(r, 1500));
    const b = await stat(p);
    return b.size !== a.size || b.mtimeMs !== a.mtimeMs;
  } catch {
    return true;
  }
}

/** Recursively import new video files under `dir`. Never throws for individual files. */
export async function scanDirectory(dir: string, opts: { onProgress?: (p: ScanProgress) => void; source?: ImportSource } = {}): Promise<ScanReport> {
  const started = Date.now();
  const root = path.resolve(dir);
  const report: ScanReport = {
    dir: root, found: 0, imported: 0, matched: 0, unmatched: 0, skippedExisting: 0, skippedInProgress: 0, restored: 0, errors: [],
    startedAt: new Date(started).toISOString(), durationMs: 0,
  };
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (e) {
    report.errors.push({ path: root, error: `Library folder is not accessible: ${errMsg(e)}` });
    report.durationMs = Date.now() - started;
    return report;
  }
  const files = await walkVideos(root);
  report.found = files.length;
  const inProgress = await downloadFilesInProgress().catch(() => new Set<string>());
  const known = new Map(
    (await db.mediaFile.findMany({ where: { path: { startsWith: root } }, select: { id: true, path: true, status: true, titleId: true, episodeId: true } })).map((f) => [f.path, f]),
  );
  let done = 0;
  for (const p of files) {
    opts.onProgress?.({ dir: root, total: files.length, done, current: p });
    done++;
    const k = known.get(p);
    if (k) {
      if (k.status === "missing") {
        await db.mediaFile.update({ where: { id: k.id }, data: { status: k.titleId || k.episodeId ? "ready" : "unmatched" } }).catch(() => {});
        report.restored++;
      } else report.skippedExisting++;
      continue;
    }
    if (inProgress.has(p) || (await isBeingWritten(p))) {
      report.skippedInProgress++;
      continue;
    }
    try {
      const r = await importFile(p, { source: opts.source ?? "import" });
      report.imported++;
      if (r.status === "ready") report.matched++;
      else report.unmatched++;
    } catch (e) {
      report.errors.push({ path: p, error: errMsg(e) });
    }
  }
  opts.onProgress?.({ dir: root, total: files.length, done });
  report.durationMs = Date.now() - started;
  return report;
}

/** Import the finished, selected video files of a download using its TMDB hint. */
export async function importDownload(downloadId: string): Promise<{ results: ImportResult[]; errors: { path: string; error: string }[] }> {
  const d = await db.download.findUnique({ where: { id: downloadId } });
  if (!d) throw new ImportError("Download not found", 404);
  const base = path.dirname(d.savePath);
  let files: { index: number; path: string; size: number; progress?: number }[] = [];
  try {
    files = JSON.parse(d.files ?? "[]");
  } catch { /* ignore */ }
  let selected: number[] | null = null;
  try {
    selected = d.selectedFiles ? JSON.parse(d.selectedFiles) : null;
  } catch { /* ignore */ }
  const sel = selected ? new Set(selected) : null;
  const finished = d.progress >= 1 || d.status === "completed" || d.status === "importing" || d.status === "imported";
  const candidates = files.filter(
    (f) => (!sel || sel.has(f.index)) && (finished || (f.progress ?? 0) >= 1) && isVideoFile(f.path) && !isSampleFile(f.path),
  );
  if (!candidates.length) throw new ImportError("No finished video files found in this download", 422);

  const results: ImportResult[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const f of candidates) {
    const abs = path.resolve(base, f.path);
    if (!abs.startsWith(path.resolve(base) + path.sep)) continue;
    let hint: ImportHint | undefined;
    if (d.tmdbId && d.mediaType === "movie") hint = { tmdbId: d.tmdbId, mediaType: "movie" };
    else if (d.tmdbId && d.mediaType === "tv") {
      const p = parseMediaFilename(f.path);
      const explicitSeason = p.kind === "episode" && !p.seasonGuessed;
      hint = {
        tmdbId: d.tmdbId,
        mediaType: "tv",
        season: explicitSeason ? p.season : d.season ?? p.season ?? 1,
        episode: p.kind === "episode" ? p.episode : undefined,
      };
    }
    try {
      results.push(await importFile(abs, { source: "torrent", hint }));
    } catch (e) {
      errors.push({ path: abs, error: errMsg(e) });
    }
  }
  if (!results.length) throw new ImportError(errors.map((e) => `${path.basename(e.path)}: ${e.error}`).join("; ") || "Nothing imported", 422);
  await db.download.update({ where: { id: downloadId }, data: { status: "imported", importedAt: new Date(), error: errors.length ? `${errors.length} file(s) failed to import` : null } });
  return { results, errors };
}

/** Mark rows whose file vanished as "missing" and restore rows whose file came back. */
export async function reconcileLibrary(): Promise<{ checked: number; missing: number; restored: number }> {
  const rows = await db.mediaFile.findMany({ select: { id: true, path: true, status: true, titleId: true, episodeId: true } });
  let missing = 0;
  let restored = 0;
  const CHUNK = 64;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const there = await Promise.all(part.map((r) => exists(r.path)));
    for (let j = 0; j < part.length; j++) {
      const r = part[j];
      if (!there[j] && r.status !== "missing") {
        await db.mediaFile.update({ where: { id: r.id }, data: { status: "missing" } });
        missing++;
      } else if (there[j] && r.status === "missing") {
        await db.mediaFile.update({ where: { id: r.id }, data: { status: r.titleId || r.episodeId ? "ready" : "unmatched" } });
        restored++;
      }
    }
  }
  return { checked: rows.length, missing, restored };
}
