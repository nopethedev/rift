import "server-only";
import { open } from "node:fs/promises";

/**
 * Client for the OpenSubtitles.com REST API (v1) — the current API, not the legacy opensubtitles.org XML-RPC / REST one.
 * Docs: https://opensubtitles.stoplight.io/docs/opensubtitles-api
 *   - every call needs an `Api-Key` and a descriptive `User-Agent`
 *   - login (username + password) returns a bearer token, needed for downloads (quota depends on the account)
 *   - GET /subtitles (search), POST /download (returns a short-lived link to the file)
 * No db / settings imports here so the client can be unit tested against a mock server.
 */

export const OS_DEFAULT_BASE = "https://api.opensubtitles.com/api/v1";
export const OS_USER_AGENT = "Rift v1.0";

export class OpenSubtitlesError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export interface OsConfig { apiKey: string; username?: string; password?: string; baseUrl?: string }

export interface OsQuery {
  /** Free-text title (used when no TMDB id is known). */
  query?: string;
  /** TMDB id of the movie, or of the *show* for episodes. */
  tmdbId?: number;
  type: "movie" | "episode";
  season?: number;
  episode?: number;
  year?: number;
  languages: string[];
  /** OpenSubtitles hash of the video file: exact release matches. */
  moviehash?: string;
}

export interface OsResult {
  /** id to pass to download(). */
  fileId: number;
  language: string;
  release: string;
  fileName: string;
  downloads: number;
  hearingImpaired: boolean;
  hashMatch: boolean;
  trusted: boolean;
  aiTranslated: boolean;
  rating: number;
  uploader: string | null;
}

export interface OsDownload { content: Buffer; fileName: string; remaining: number | null }

/** The OpenSubtitles file hash: file size + 64-bit little-endian word sum of the first and last 64 KiB (mod 2^64), 16 hex chars. */
export async function openSubtitlesHash(file: string): Promise<string | null> {
  const CHUNK = 65536;
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size < CHUNK * 2) return null; // too small to hash reliably
    let hash = BigInt(size);
    const mask = (1n << 64n) - 1n;
    const buf = Buffer.alloc(CHUNK);
    for (const pos of [0, size - CHUNK]) {
      await fh.read(buf, 0, CHUNK, pos);
      for (let i = 0; i < CHUNK; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & mask;
    }
    return hash.toString(16).padStart(16, "0");
  } finally {
    await fh.close();
  }
}

/** Best result first: exact hash match, then trusted/human, then non-SDH, then popularity. */
export function rankResults(list: OsResult[]): OsResult[] {
  const score = (r: OsResult) => (r.hashMatch ? 1e9 : 0) + (r.trusted ? 1e6 : 0) + (r.aiTranslated ? 0 : 5e5) + (r.hearingImpaired ? 0 : 1e5) + r.downloads;
  return [...list].sort((a, b) => score(b) - score(a));
}

export class OpenSubtitles {
  private token: { value: string; base: string; exp: number } | null = null;
  constructor(private cfg: OsConfig) {}

  private get base() { return (this.cfg.baseUrl || OS_DEFAULT_BASE).replace(/\/$/, ""); }
  private headers(auth: boolean, json = false): Record<string, string> {
    const h: Record<string, string> = { "Api-Key": this.cfg.apiKey, "User-Agent": OS_USER_AGENT, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (auth && this.token) h.Authorization = `Bearer ${this.token.value}`;
    return h;
  }

  private async call(url: string, init: RequestInit): Promise<any> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new OpenSubtitlesError(`Could not reach OpenSubtitles: ${(e as Error).message}`, 502);
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = data?.message ?? data?.error ?? text.slice(0, 200);
      if (res.status === 401 || res.status === 403) throw new OpenSubtitlesError(`OpenSubtitles rejected the credentials (${res.status}): ${msg}. Check the API key, username and password.`, 502);
      if (res.status === 406) throw new OpenSubtitlesError(`OpenSubtitles download quota reached${data?.remaining === 0 ? "" : `: ${msg}`}. It resets daily; a VIP account raises the limit.`, 429);
      if (res.status === 429) throw new OpenSubtitlesError("OpenSubtitles rate limit hit, try again in a few seconds.", 429);
      throw new OpenSubtitlesError(`OpenSubtitles error ${res.status}: ${msg}`, 502);
    }
    return data;
  }

  /** Logs in once and reuses the token (valid 24 h). Without username/password downloads still work with the API key alone (tiny quota). */
  async login(force = false): Promise<boolean> {
    if (!this.cfg.username || !this.cfg.password) return false;
    if (!force && this.token && this.token.exp > Date.now()) return true;
    const data = await this.call(`${this.base}/login`, { method: "POST", headers: this.headers(false, true), body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }) });
    if (!data?.token) throw new OpenSubtitlesError("OpenSubtitles login returned no token", 502);
    this.token = { value: data.token, base: this.base, exp: Date.now() + 23 * 3600_000 };
    return true;
  }

  async search(q: OsQuery): Promise<OsResult[]> {
    // The API wants lower-case, alphabetically sorted parameters (it redirects otherwise).
    const p: Record<string, string> = { languages: [...new Set(q.languages.map((l) => l.toLowerCase().slice(0, 5)))].sort().join(","), order_by: "download_count", order_direction: "desc", type: q.type };
    if (q.type === "episode") {
      if (q.tmdbId) p.parent_tmdb_id = String(q.tmdbId);
      if (q.season !== undefined) p.season_number = String(q.season);
      if (q.episode !== undefined) p.episode_number = String(q.episode);
    } else if (q.tmdbId) p.tmdb_id = String(q.tmdbId);
    if (!q.tmdbId && q.query) { p.query = q.query.toLowerCase(); if (q.year && q.type === "movie") p.year = String(q.year); }
    if (q.moviehash) p.moviehash = q.moviehash;
    const qs = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join("&");
    await this.login().catch(() => {}); // search works without a token; don't fail on bad login here
    const data = await this.call(`${this.base}/subtitles?${qs}`, { headers: this.headers(true) });
    const out: OsResult[] = [];
    for (const d of data?.data ?? []) {
      const a = d.attributes ?? {};
      const f = a.files?.[0];
      if (!f?.file_id) continue;
      out.push({
        fileId: f.file_id, language: a.language ?? "und", release: a.release ?? a.feature_details?.title ?? "", fileName: f.file_name ?? "",
        downloads: a.download_count ?? 0, hearingImpaired: !!a.hearing_impaired, hashMatch: !!a.moviehash_match, trusted: !!a.from_trusted,
        aiTranslated: !!(a.ai_translated || a.machine_translated), rating: a.ratings ?? 0, uploader: a.uploader?.name ?? null,
      });
    }
    return rankResults(out);
  }

  /** Resolve the download link and fetch the subtitle as SRT. */
  async download(fileId: number): Promise<OsDownload> {
    await this.login();
    const info = await this.call(`${this.base}/download`, { method: "POST", headers: this.headers(true, true), body: JSON.stringify({ file_id: fileId, sub_format: "srt" }) });
    if (!info?.link) throw new OpenSubtitlesError(info?.message ?? "OpenSubtitles did not return a download link", 502);
    let res: Response;
    try { res = await fetch(info.link, { headers: { "User-Agent": OS_USER_AGENT }, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { throw new OpenSubtitlesError(`Subtitle download failed: ${(e as Error).message}`, 502); }
    if (!res.ok) throw new OpenSubtitlesError(`Subtitle download failed (${res.status})`, 502);
    const content = Buffer.from(await res.arrayBuffer());
    if (content.length > 5 * 1024 * 1024) throw new OpenSubtitlesError("Subtitle file is unexpectedly large", 502);
    return { content, fileName: info.file_name ?? `${fileId}.srt`, remaining: typeof info.remaining === "number" ? info.remaining : null };
  }

  /** Verifies key + credentials; returns the account's remaining download quota when logged in. */
  async test(): Promise<{ loggedIn: boolean; remaining?: number; level?: string }> {
    const loggedIn = await this.login(true);
    if (!loggedIn) {
      await this.call(`${this.base}/infos/languages`, { headers: this.headers(false) }); // validates the API key
      return { loggedIn: false };
    }
    const me = await this.call(`${this.base}/infos/user`, { headers: this.headers(true) }).catch(() => null);
    return { loggedIn: true, remaining: me?.data?.remaining_downloads, level: me?.data?.level };
  }
}
