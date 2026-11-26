// Bandcamp → CDN audio URL: the track page carries its 128 kbps MP3 stream in the player's data (what bandcamp.com plays).
import { EngineError } from "../engines/types";
import type { DirectAudio } from "./types";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";

const decodeEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseBandcampPage(html: string): { url: string; durationSec: number } {
  const raw = html.match(/data-tralbum="([^"]+)"/)?.[1];
  if (!raw) throw new EngineError("Bandcamp page has no player data", "failed");
  const data = JSON.parse(decodeEntities(raw)) as { trackinfo?: { file?: Record<string, string> | null; duration?: number }[] };
  const t = data.trackinfo?.find((x) => x.file && x.file["mp3-128"]);
  if (!t?.file) throw new EngineError("This Bandcamp track can't be streamed (purchase only)", "not-found");
  return { url: t.file["mp3-128"], durationSec: t.duration ?? 0 };
}

export async function extractBandcamp(pageUrl: string): Promise<DirectAudio> {
  const r = await fetch(pageUrl, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new EngineError(`Bandcamp answered ${r.status}`, r.status === 404 ? "not-found" : "failed");
  const { url, durationSec } = parseBandcampPage(await r.text());
  return { url, headers: { "User-Agent": UA }, mime: "audio/mpeg", durationSec, expiresAt: Date.now() + 30 * 60_000, via: "bandcamp" };
}
