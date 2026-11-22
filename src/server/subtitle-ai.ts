import "server-only";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { env } from "./config";
import { HttpError } from "./api";
import { getSettings, type Settings } from "./settings";
import { whisperWorker, type WhisperJob, type WhisperWorkerStatus } from "./whisper";
import type { ProbeResult } from "@shared/probe";
import type { Subtitle } from "@/generated/prisma/client";

// Automatic subtitles: the worker transcribes the audio with Whisper; this service owns the DB row and the .vtt file,
// copies the (growing) result from the worker while the job runs, and starts jobs on request or when a title is played.

const languageName = (code: string) => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; } };
const AI = "AI";

export interface AiState {
  /** The feature is on, the worker has the speech engine, and this user may use it. */
  available: boolean;
  /** Why it is not available (shown to admins / in the player). */
  reason?: string;
  /** The AI subtitle track of this file, if one exists or is being generated. */
  subtitle?: { id: string; status: "generating" | "ready" | "failed"; progress: number; label: string; language?: string; note?: string };
}

// ---------- worker availability (cached briefly) ----------
let statusCache: { at: number; v: WhisperWorkerStatus | { error: string } } | null = null;
export async function workerStatus(): Promise<WhisperWorkerStatus | { error: string }> {
  if (statusCache && Date.now() - statusCache.at < 30_000) return statusCache.v;
  const v = await whisperWorker.status().catch((e: Error) => ({ error: e.message }));
  statusCache = { at: Date.now(), v };
  return v;
}
export const resetWorkerStatus = () => { statusCache = null; };

export function mayUse(s: Settings, user: { role: "ADMIN" | "USER" }) {
  return s.whisperEnabled && (s.whisperAccess === "everyone" || user.role === "ADMIN");
}

const subDir = (fileId: string) => path.join(env.dataDir, "subtitles", fileId);

function label(lang: string | undefined, o: { translate: boolean; status: string; progress: number }) {
  const name = o.translate ? "English" : lang ? languageName(lang) : "Auto";
  return `${name} (${AI}${o.translate ? " translation" : ""})`;
}

const dto = (s: Subtitle): NonNullable<AiState["subtitle"]> => ({ id: s.id, status: s.status as "generating" | "ready" | "failed", progress: s.progress ?? (s.status === "ready" ? 1 : 0), label: s.label, language: s.language ?? undefined, note: s.note ?? undefined });

/** What the player needs to know about AI subtitles for one file. */
export async function aiState(fileId: string, user: { role: "ADMIN" | "USER" }): Promise<AiState> {
  const s = await getSettings();
  const row = await db.subtitle.findFirst({ where: { mediaFileId: fileId, source: "auto" }, orderBy: { createdAt: "desc" } });
  const sub = row ? dto(row) : undefined;
  if (!mayUse(s, user)) return { available: false, reason: s.whisperEnabled ? "Automatic subtitles are limited to administrators." : "Automatic subtitles are turned off.", subtitle: sub };
  const w = await workerStatus();
  if ("error" in w && !("installed" in w)) return { available: false, reason: w.error, subtitle: sub };
  const ws = w as WhisperWorkerStatus;
  if (!ws.installed) return { available: false, reason: ws.error ?? "The speech engine is not installed on the worker.", subtitle: sub };
  return { available: true, subtitle: sub };
}

// ---------- watching jobs ----------
const g = globalThis as unknown as { __riftAiWatch?: Map<string, NodeJS.Timeout> };
const watchers = (g.__riftAiWatch ??= new Map());

async function writeVtt(file: string, text: string) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** Copies the worker's progress into the row and file until the job ends. Safe to call twice for one subtitle. */
function watch(subId: string) {
  if (watchers.has(subId)) return;
  let lastVersion = -1;
  let misses = 0;
  const tick = async () => {
    const sub = await db.subtitle.findUnique({ where: { id: subId } });
    if (!sub || sub.status !== "generating" || !sub.jobId) return stop();
    let job: WhisperJob;
    try { job = await whisperWorker.job(sub.jobId); misses = 0; }
    catch (e) {
      // Worker restarted (job gone) or unreachable for a while: give up with a clear reason.
      if ((e instanceof HttpError && e.status === 404) || ++misses >= 10) {
        await db.subtitle.update({ where: { id: subId }, data: { status: "failed", note: e instanceof HttpError && e.status === 404 ? "The worker restarted before the subtitles were finished. Generate them again." : "The worker could not be reached." } }).catch(() => {});
        return stop();
      }
      return;
    }
    try {
      if (job.version !== lastVersion) {
        const vtt = await whisperWorker.vtt(job.id);
        await writeVtt(sub.path, vtt);
        lastVersion = job.version;
      }
    } catch { /* try again next tick */ }
    const lang = job.language ?? sub.language ?? undefined;
    if (job.state === "done") {
      await db.subtitle.update({ where: { id: subId }, data: { status: "ready", progress: 1, language: lang ?? null, label: label(lang, { translate: job.translate && lang !== "en", status: "ready", progress: 1 }), note: null } }).catch(() => {});
      return stop();
    }
    if (job.state === "failed" || job.state === "cancelled") {
      await db.subtitle.update({ where: { id: subId }, data: { status: "failed", note: job.state === "cancelled" ? "Cancelled" : job.error ?? "Failed" } }).catch(() => {});
      return stop();
    }
    await db.subtitle.update({ where: { id: subId }, data: { progress: job.progress, language: lang ?? null, note: job.state === "queued" ? `Waiting in line (${job.queuePosition ?? 1})` : job.state === "loading" ? "Loading the speech model…" : job.state === "detecting" ? "Detecting the language…" : null, label: label(lang, { translate: job.translate && lang !== "en", status: "generating", progress: job.progress }) } }).catch(() => {});
  };
  const stop = () => { const t = watchers.get(subId); if (t) clearInterval(t); watchers.delete(subId); };
  const timer = setInterval(() => void tick().catch(() => {}), 3000);
  timer.unref();
  watchers.set(subId, timer);
  void tick().catch(() => {});
}

/** After a web restart: reattach to jobs still running on the worker, fail the rest. */
export async function resumeAiSubtitles() {
  const rows = await db.subtitle.findMany({ where: { source: "auto", status: "generating" } });
  for (const r of rows) watch(r.id);
}

// ---------- starting ----------
export interface AiStartOptions { translate?: boolean; language?: string; startSec?: number; auto?: boolean }

export async function startAiSubtitles(fileId: string, user: { role: "ADMIN" | "USER" }, o: AiStartOptions = {}): Promise<NonNullable<AiState["subtitle"]>> {
  const s = await getSettings();
  if (!mayUse(s, user)) throw new HttpError(403, s.whisperEnabled ? "Automatic subtitles are limited to administrators." : "Automatic subtitles are turned off.");
  const file = await db.mediaFile.findUnique({ where: { id: fileId } });
  if (!file || file.status === "missing") throw new HttpError(404, "Media not found");
  const translate = o.translate ?? s.whisperTranslate;
  const language = o.language ?? s.whisperLanguage;
  // One AI track per file and option set: asking again returns the existing one (a failed one is retried).
  const existing = await db.subtitle.findFirst({ where: { mediaFileId: fileId, source: "auto", format: translate ? "ai-translate" : "ai" }, orderBy: { createdAt: "desc" } });
  if (existing && existing.status !== "failed") { if (existing.status === "generating") watch(existing.id); return dto(existing); }

  let probe: ProbeResult | null = null;
  try { probe = file.probe ? (JSON.parse(file.probe) as ProbeResult) : null; } catch { /* ignore */ }
  const audio = probe?.streams.filter((x) => x.type === "audio") ?? [];
  if (probe && !audio.length) throw new HttpError(422, "This file has no audio track to transcribe.");
  // Prefer the track marked default, else the first.
  const track = audio.find((a) => a.default) ?? audio[0];

  const job = await whisperWorker.start({ inputPath: file.path, audioStreamIndex: track?.index, startSec: o.startSec && o.startSec > 5 ? o.startSec : undefined, language, translate, model: s.whisperModel });
  const id = existing?.id ?? randomUUID();
  const out = path.join(subDir(fileId), `ai-${job.id.slice(0, 12)}.vtt`);
  await mkdir(subDir(fileId), { recursive: true });
  await writeFile(out, "WEBVTT\n\n", "utf8");
  const data = { mediaFileId: fileId, language: language === "auto" ? null : language, label: label(language === "auto" ? undefined : language, { translate, status: "generating", progress: 0 }), format: translate ? "ai-translate" : "ai", path: out, source: "auto", isDefault: false, status: "generating", progress: 0, jobId: job.id, note: null as string | null };
  const row = existing ? await db.subtitle.update({ where: { id }, data }) : await db.subtitle.create({ data: { id, ...data } });
  watch(row.id);
  return dto(row);
}

export async function cancelAiSubtitles(fileId: string, user: { role: "ADMIN" | "USER" }) {
  const s = await getSettings();
  if (!mayUse(s, user)) throw new HttpError(403, "Not allowed");
  const rows = await db.subtitle.findMany({ where: { mediaFileId: fileId, source: "auto", status: "generating" } });
  for (const r of rows) {
    if (r.jobId) await whisperWorker.cancel(r.jobId).catch(() => {});
    await db.subtitle.update({ where: { id: r.id }, data: { status: "failed", note: "Cancelled" } });
  }
}

export async function deleteAiSubtitle(subId: string) {
  const sub = await db.subtitle.findUnique({ where: { id: subId } });
  if (!sub || sub.source !== "auto") throw new HttpError(404, "Subtitle not found");
  if (sub.jobId && sub.status === "generating") await whisperWorker.cancel(sub.jobId).catch(() => {});
  await db.subtitle.delete({ where: { id: subId } });
  await rm(sub.path, { force: true }).catch(() => {});
}

/**
 * Called when a player loads a file: if automatic subtitles are on and the file has no subtitles at all, start generating
 * them from the viewer's position. Never throws (it must not break playback).
 */
export async function maybeAutoGenerate(fileId: string, user: { role: "ADMIN" | "USER" }, startSec: number, hasSubtitles: boolean): Promise<void> {
  try {
    if (hasSubtitles) return;
    const s = await getSettings();
    if (!s.whisperAuto || !mayUse(s, user)) return;
    const w = await workerStatus();
    if (!("installed" in w) || !w.installed) return;
    await startAiSubtitles(fileId, user, { startSec, auto: true });
  } catch { /* best effort */ }
}
