// SoundCloud → CDN audio URL through its public web API (the same calls soundcloud.com makes), as NewPipe does.
import { EngineError } from "../engines/types";
import type { DirectAudio } from "./types";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
let clientId: { id: Promise<string>; at: number } | null = null;

/** soundcloud.com's public client id, read from its JS bundle. Kept for a day, renewed when the API rejects it. */
async function getClientId(force = false): Promise<string> {
  if (force || !clientId || Date.now() - clientId.at > 24 * 3600_000) {
    const id = (async () => {
      const html = await (await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA } })).text();
      const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
      for (const src of scripts) {
        const m = findClientId(await (await fetch(src, { headers: { "User-Agent": UA } })).text());
        if (m) return m;
      }
      throw new EngineError("Couldn't find SoundCloud's client id", "unavailable");
    })();
    clientId = { id, at: Date.now() };
    id.catch(() => { clientId = null; });
  }
  return clientId.id;
}

export const findClientId = (js: string): string | undefined => js.match(/[{,]client_id:"([A-Za-z0-9]{32})"/)?.[1];

interface Transcoding { url: string; preset?: string; snipped?: boolean; format?: { protocol?: string; mime_type?: string } }
export interface ScTrack { id: number; duration?: number; streamable?: boolean; policy?: string; track_authorization?: string; media?: { transcodings?: Transcoding[] } }

/**
 * Best transcoding: full-length (not a 30 s preview), progressive before HLS, MP3 before Opus/AAC (MP3 HLS segments can
 * simply be concatenated).
 */
export function pickTranscoding(t: ScTrack): Transcoding | undefined {
  const ok = (t.media?.transcodings ?? []).filter((x) => !x.snipped && x.format?.protocol && /^(progressive|hls)$/.test(x.format.protocol) && !/encrypted/.test(x.format.protocol));
  const rank = (x: Transcoding) => (x.format!.protocol === "progressive" ? 0 : 10) + (/mpeg/.test(x.format!.mime_type ?? "") ? 0 : /ogg|opus/.test(x.format!.mime_type ?? "") ? 1 : 2);
  return ok.sort((a, b) => rank(a) - rank(b))[0];
}

async function api<T>(url: string, retry = true): Promise<T> {
  const id = await getClientId();
  const u = new URL(url);
  u.searchParams.set("client_id", id);
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if ((r.status === 401 || r.status === 403) && retry) { await getClientId(true); return api<T>(url, false); }
  if (r.status === 404) throw new EngineError("This SoundCloud track doesn't exist or is private", "not-found");
  if (!r.ok) throw new EngineError(`SoundCloud answered ${r.status}`, "failed");
  return (await r.json()) as T;
}

export async function extractSoundCloud(pageUrl: string): Promise<DirectAudio> {
  const t = await api<ScTrack>(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(pageUrl.split("?")[0])}`);
  if (t.policy === "BLOCK") throw new EngineError("This SoundCloud track is blocked in the worker's country", "not-found");
  const tc = pickTranscoding(t);
  if (!tc) throw new EngineError("This SoundCloud track only offers a preview (SoundCloud Go+)", "not-found");
  const u = new URL(tc.url);
  if (t.track_authorization) u.searchParams.set("track_authorization", t.track_authorization);
  const { url } = await api<{ url: string }>(u.toString());
  const hls = tc.format!.protocol === "hls";
  return {
    url,
    headers: { "User-Agent": UA },
    mime: (tc.format!.mime_type ?? "audio/mpeg").split(";")[0],
    durationSec: (t.duration ?? 0) / 1000,
    expiresAt: Date.now() + 20 * 60_000,
    hls,
    via: `soundcloud/${hls ? "hls" : "progressive"}`,
  };
}
