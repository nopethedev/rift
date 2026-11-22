// Pure helpers: Whisper words -> readable subtitle cues -> WebVTT. No I/O, unit tested.

export interface Word { text: string; start: number; end: number }
export interface Cue { start: number; end: number; text: string }

export interface CueOptions {
  maxLineChars?: number; // characters per line (default 42)
  maxLines?: number; // lines per cue (default 2)
  maxDurationSec?: number; // default 7
  gapSec?: number; // a pause at least this long starts a new cue (default 0.9)
  minDurationSec?: number; // short cues are extended up to this (default 0.8)
}

const SENTENCE_END = /[.!?…。！？]["')\]]*$/;
const CLAUSE_END = /[,;:、，]["')\]]*$/;

/** Normalised text for comparisons: lower case, no punctuation. */
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Breaks text into at most `maxLines` lines of about `maxChars`, balancing the lines. */
export function wrapLines(text: string, maxChars: number, maxLines: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars || maxLines < 2) return t;
  const words = t.split(" ");
  // Try every split point and keep the most balanced one that fits.
  let best: string | null = null, bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (a.length > maxChars || b.length > maxChars) continue;
    const score = Math.abs(a.length - b.length) + (SENTENCE_END.test(a) || CLAUSE_END.test(a) ? -4 : 0);
    if (score < bestScore) { bestScore = score; best = `${a}\n${b}`; }
  }
  if (best) return best;
  // Too long for two lines: greedy wrap (cue builder keeps cues short enough that this is rare).
  const lines: string[] = [];
  let cur = "";
  for (const w of words) { if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

/** Groups timed words into cues: split on pauses, sentence ends, length and duration limits. */
export function wordsToCues(words: Word[], o: CueOptions = {}): Cue[] {
  const maxChars = (o.maxLineChars ?? 42) * (o.maxLines ?? 2);
  const maxDur = o.maxDurationSec ?? 7, gap = o.gapSec ?? 0.9, minDur = o.minDurationSec ?? 0.8;
  const sorted = words.filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  const textLen = (ws: Word[]) => ws.reduce((n, x) => n + x.text.trim().length + 1, -1);
  const fits = (ws: Word[]) => textLen(ws) <= maxChars && ws[ws.length - 1].end - ws[0].start <= maxDur;
  /** Splits a phrase that is too long into pieces that fit, cutting at pauses / punctuation near the middle. */
  const split = (ws: Word[]): Word[][] => {
    if (ws.length < 2 || fits(ws)) return [ws];
    const total = textLen(ws);
    let best = Math.ceil(ws.length / 2), bestScore = -Infinity, run = 0;
    for (let k = 1; k < ws.length; k++) {
      run += ws[k - 1].text.trim().length + 1;
      const balance = 1 - Math.abs(run / total - 0.5) * 2; // 1 in the middle, 0 at the ends
      if (balance < 0.35) continue; // keep both halves reasonably sized
      const t = ws[k - 1].text.trim();
      const score = (ws[k].start - ws[k - 1].end) + (SENTENCE_END.test(t) ? 0.7 : CLAUSE_END.test(t) ? 0.45 : 0) + balance * 0.4;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return [...split(ws.slice(0, best)), ...split(ws.slice(best))];
  };
  const emit = (ws: Word[]) => {
    const text = ws.map((w) => w.text.trim()).join(" ").replace(/\s+([,.;:!?…])/g, "$1").trim();
    if (text) cues.push({ start: ws[0].start, end: Math.max(ws[ws.length - 1].end, ws[0].start + 0.2), text });
  };
  // 1. phrases: hard breaks at pauses and finished sentences
  let cur: Word[] = [];
  const flush = () => { if (cur.length) for (const piece of split(cur)) emit(piece); cur = []; };
  for (const w of sorted) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const sentenceDone = SENTENCE_END.test(prev.text.trim()) && (textLen(cur) > 28 || prev.end - cur[0].start > 2.5);
      if (w.start - prev.end > gap || sentenceDone) flush();
    }
    cur.push(w);
  }
  flush();
  // Timing polish: minimum duration without overlapping the next cue; hold a cue a moment past its last word.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const limit = next ? next.start - 0.04 : Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end + 0.15, cues[i].start + minDur), limit);
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.2;
  }
  return cues.map((c) => ({ ...c, text: wrapLines(c.text, o.maxLineChars ?? 42, o.maxLines ?? 2) }));
}

// ---------- hallucination control ----------
/** Phrases Whisper invents over silence, music and credits. */
const JUNK = /\b(amara\.org|subtitles? (by|from)|subtitled by|captions? by|transcribed by|translated by|synced (and corrected )?by|subscribe (to|for)|like and subscribe|thanks? for watching|thank you for watching|www\.[a-z0-9-]+\.|opensubtitles)\b/i;
/** Short filler it emits on near-silence; only dropped when the audio under it is quiet. */
const WEAK = new Set(["you", "thank you", "thanks", "bye", "bye bye", "okay", "so", "the", "oh", "uh", "um", "hmm", "mm", "mhm", "music", "applause", "silence"]);

export interface CleanOptions {
  /** Mean audio level (0..1, RMS) between two times, when known. */
  rms?: (start: number, end: number) => number | undefined;
  quiet?: number; // below this a weak phrase is dropped (default 0.012)
}

export function cleanCues(cues: Cue[], o: CleanOptions = {}): Cue[] {
  const quiet = o.quiet ?? 0.012;
  const out: Cue[] = [];
  for (const c of cues) {
    const t = c.text.replace(/\s+/g, " ").trim();
    const n = norm(t);
    if (!n) continue;
    if (JUNK.test(t)) continue;
    // Sound-effect markers Whisper writes ("[Music]", "(applause)") are kept: they help deaf viewers.
    const level = o.rms?.(c.start, c.end);
    if (/^[\[(♪*]/.test(t)) { out.push({ ...c, text: c.text.trim() }); continue; }
    if (WEAK.has(n) && level !== undefined && level < quiet) continue;
    if (level !== undefined && level < quiet / 4) continue; // text over (near) silence
    // Hallucination loops: the same text again and again.
    const same = out.slice(-3).filter((p) => norm(p.text) === n).length;
    if (same >= 2) continue;
    const last = out[out.length - 1];
    if (last && norm(last.text) === n && c.start - last.end < 1.5) { last.end = Math.max(last.end, c.end); continue; }
    out.push({ ...c, text: c.text.trim() });
  }
  return out;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
export function vttTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(ms / 3600000)}:${pad((ms % 3600000) / 60000)}:${pad((ms % 60000) / 1000)}.${pad(ms % 1000, 3)}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // also defuses "-->";

export function toVtt(cues: Cue[]): string {
  let out = "WEBVTT\n\n";
  cues.forEach((c, i) => { out += `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${esc(c.text)}\n\n`; });
  return out;
}

/** Mean of the measured energy bins (`binSec` each, negative/NaN = not measured) over [start, end); undefined when none were measured. */
export function windowEnergy(bins: ArrayLike<number>, binSec: number, start: number, end: number): number | undefined {
  const a = Math.max(0, Math.floor(start / binSec)), b = Math.min(bins.length, Math.max(a + 1, Math.ceil(end / binSec)));
  let s = 0, n = 0;
  for (let i = a; i < b; i++) if (bins[i] >= 0) { s += bins[i]; n++; }
  return n ? s / n : undefined;
}
