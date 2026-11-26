// YouTube → CDN audio URL, the way NewPipe (and Rift Solo) do it: ask YouTube's internal API ("InnerTube") as one of its
// own apps, pick the best audio-only format and decipher its URL. No yt-dlp process, no Lavalink voice connection.
import vm from "node:vm";
import { Constants, Innertube, Platform, type Types } from "youtubei.js";
import { EngineError } from "../engines/types";
import type { DirectAudio } from "./types";

/**
 * YouTube serves its player script to decipher stream URLs. youtubei.js needs a JavaScript evaluator for it; the script
 * runs in a fresh V8 context (no access to Rift's globals, require, process...) with a time limit.
 */
Platform.shim.eval = (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const props: string[] = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return vm.runInNewContext(`(function(){${data.output}\nreturn { ${props.join(", ")} }})()`, Object.create(null), { timeout: 3000 });
};

/**
 * Clients tried in order. visionOS / Android VR / iOS return audio URLs that play without a PO token (what NewPipe uses);
 * the TV client is a last resort for videos the others refuse.
 */
const CLIENTS = ["VISIONOS", "ANDROID_VR", "IOS", "TV"] as const;
type Client = (typeof CLIENTS)[number];

/** User agent of each client (taken from youtubei.js so it stays in step): its CDN URLs expect the same one. */
const CLIENT_UA: Partial<Record<Client, string>> = {
  VISIONOS: Constants.CLIENTS.VISIONOS.USER_AGENT,
  IOS: Constants.CLIENTS.IOS.USER_AGENT,
  ANDROID_VR: Constants.CLIENTS.ANDROID_VR.USER_AGENT,
  TV: Constants.CLIENTS.TV.USER_AGENT,
};

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
let session: { yt: Promise<Innertube>; at: number } | null = null;

/** One shared InnerTube session, renewed every few hours (YouTube rotates its player script). */
export function innertube(): Promise<Innertube> {
  if (!session || Date.now() - session.at > SESSION_TTL_MS) {
    const yt = Innertube.create({ retrieve_player: true, generate_session_locally: true });
    session = { yt, at: Date.now() };
    yt.catch(() => { session = null; });
  }
  return session.yt;
}

const ID = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/;
export const youtubeId = (url: string): string | null => (/youtu/.test(url) ? url.match(ID)?.[1] ?? null : /^[A-Za-z0-9_-]{11}$/.test(url) ? url : null);

export async function extractYouTube(url: string): Promise<DirectAudio> {
  const id = youtubeId(url);
  if (!id) throw new EngineError(`Not a YouTube video URL: ${url}`, "failed");
  const yt = await innertube();
  let last: Error | undefined;
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      if (info.basic_info.is_live) throw new EngineError("Live streams are not supported", "failed");
      const f = info.chooseFormat({ type: "audio", quality: "best", format: "any" });
      const direct = await f.decipher(yt.session.player);
      if (!direct) throw new Error("empty stream URL");
      return {
        url: direct,
        headers: CLIENT_UA[client] ? { "User-Agent": CLIENT_UA[client]! } : {},
        mime: f.mime_type.split(";")[0] || "audio/mp4",
        contentLength: f.content_length ? Number(f.content_length) : undefined,
        durationSec: info.basic_info.duration ?? 0,
        expiresAt: expiryOf(direct),
        // Google's CDN throttles long single requests; it serves fast in ranges (what YouTube's own players do).
        chunked: true,
        via: `youtube/${client.toLowerCase()}`,
      };
    } catch (e) {
      last = e as Error;
      if (e instanceof EngineError && e.code !== "failed") throw e;
    }
  }
  const msg = last?.message ?? "no client could play it";
  throw new EngineError(`YouTube refused "${id}" (${msg.slice(0, 160)})`, /sign in|bot|login|unavailable|not available|private/i.test(msg) ? "not-found" : "failed");
}

/** Regular video uploads for a search: alternates when a YouTube Music "Topic" upload is refused, and matches for Spotify tracks. */
export async function searchYouTubeVideos(text: string, limit = 8): Promise<{ id: string; title: string; artist: string; durationSec: number; url: string; artworkUrl?: string }[]> {
  const yt = await innertube();
  const res = await yt.search(text, { type: "video" });
  const out: { id: string; title: string; artist: string; durationSec: number; url: string; artworkUrl?: string }[] = [];
  for (const v of res.videos) {
    const node = v as unknown as { id?: string; video_id?: string; title?: { toString(): string }; author?: { name?: string }; duration?: { seconds?: number }; thumbnails?: { url: string }[]; is_live?: boolean };
    const id = node.id ?? node.video_id;
    if (!id || node.is_live) continue;
    out.push({ id, title: node.title?.toString() ?? "", artist: node.author?.name ?? "", durationSec: node.duration?.seconds ?? 0, url: `https://www.youtube.com/watch?v=${id}`, artworkUrl: node.thumbnails?.[0]?.url });
    if (out.length >= limit) break;
  }
  return out;
}

function expiryOf(url: string): number {
  const exp = Number(new URL(url).searchParams.get("expire"));
  return exp > 0 ? exp * 1000 : Date.now() + 60 * 60 * 1000;
}
