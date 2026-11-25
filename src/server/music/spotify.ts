// Spotify playlist / album import. Only METADATA is read (names, artists, artwork URLs, order). No audio is fetched
// from Spotify, and nothing here touches its DRM: playback comes from the local library or an authorised source.
import "server-only";
import { getSettings } from "../settings";

export interface ImportedTrack { externalId?: string; title: string; artist: string; album?: string; durationSec?: number; artworkUrl?: string; isrc?: string }
export interface ImportedPlaylist { kind: "playlist" | "album"; sourceId: string; name: string; description?: string; artworkUrl?: string; tracks: ImportedTrack[]; truncated: boolean; via: "api" | "embed" }

export class SpotifyError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

/** fetch() with network failures / timeouts turned into a readable SpotifyError. */
async function spfetch(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch (e) { throw new SpotifyError(`Could not reach Spotify (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}). Check the server's internet access.`, 502); }
}

export function parseSpotifyUrl(input: string): { kind: "playlist" | "album"; id: string } | null {
  const s = input.trim();
  let m = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(s);
  if (m) return { kind: m[1] as "playlist" | "album", id: m[2] };
  try {
    const u = new URL(s);
    if (u.hostname !== "open.spotify.com" && u.hostname !== "play.spotify.com") return null;
    m = /\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/.exec(u.pathname);
    return m ? { kind: m[1] as "playlist" | "album", id: m[2] } : null;
  } catch { return null; }
}

// ---------- Web API (needs a client id/secret; works for public playlists and albums) ----------
interface ApiTrack { id?: string; name?: string; duration_ms?: number; artists?: { name: string }[]; album?: { name?: string; images?: { url: string }[] }; external_ids?: { isrc?: string }; is_local?: boolean }

export function mapApiTrack(t: ApiTrack | null | undefined): ImportedTrack | null {
  if (!t || !t.name || t.is_local) return null;
  return {
    externalId: t.id, title: t.name, artist: (t.artists ?? []).map((a) => a.name).join(", ") || "Unknown artist", album: t.album?.name,
    durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined, artworkUrl: t.album?.images?.[t.album.images.length > 1 ? 1 : 0]?.url, isrc: t.external_ids?.isrc,
  };
}

const g = globalThis as unknown as { __riftSpotifyToken?: { key: string; token: string; until: number } };
/** Client-credentials token, reused until shortly before it expires (an hour). */
async function apiToken(id: string, secret: string): Promise<string> {
  const key = `${id}:${secret}`;
  const hit = g.__riftSpotifyToken;
  if (hit && hit.key === key && hit.until > Date.now()) return hit.token;
  const r = await spfetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new SpotifyError(`Spotify rejected the client credentials (${r.status}). Check them in Admin → Music → Settings.`, 502);
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  g.__riftSpotifyToken = { key, token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 };
  return j.access_token;
}

async function viaApi(kind: "playlist" | "album", id: string, cid: string, secret: string): Promise<ImportedPlaylist> {
  const token = await apiToken(cid, secret);
  const get = async <T>(url: string): Promise<T> => {
    const r = await spfetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404 || r.status === 403) throw new SpotifyError("Spotify says this playlist is private or not available to the app. Make it public, or use a public copy.", 404);
    if (!r.ok) throw new SpotifyError(`Spotify API error ${r.status}`);
    return (await r.json()) as T;
  };
  const tracks: ImportedTrack[] = [];
  if (kind === "playlist") {
    const meta = await get<{ name: string; description?: string; images?: { url: string }[] }>(`https://api.spotify.com/v1/playlists/${id}?fields=name,description,images`);
    let url: string | null = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(is_local,track(id,name,duration_ms,artists(name),album(name,images),external_ids))`;
    while (url && tracks.length < 2000) {
      const page: { next: string | null; items: { track: ApiTrack | null; is_local?: boolean }[] } = await get(url);
      for (const it of page.items) { const t = mapApiTrack(it.track ? { ...it.track, is_local: it.is_local } : null); if (t) tracks.push(t); }
      url = page.next;
    }
    return { kind, sourceId: id, name: meta.name, description: meta.description || undefined, artworkUrl: meta.images?.[0]?.url, tracks, truncated: false, via: "api" };
  }
  const meta = await get<{ name: string; images?: { url: string }[]; artists?: { name: string }[]; tracks: { items: ApiTrack[]; next: string | null } }>(`https://api.spotify.com/v1/albums/${id}`);
  let page = meta.tracks;
  for (;;) {
    for (const t of page.items) { const m = mapApiTrack({ ...t, album: { name: meta.name, images: meta.images } }); if (m) tracks.push(m); }
    if (!page.next) break;
    page = await get(page.next);
  }
  return { kind, sourceId: id, name: meta.name, description: meta.artists?.map((a) => a.name).join(", "), artworkUrl: meta.images?.[0]?.url, tracks, truncated: false, via: "api" };
}

// ---------- embed page (no credentials; public playlists/albums, first 100 tracks) ----------
interface EmbedTrack { uri?: string; title?: string; subtitle?: string; duration?: number; isExplicit?: boolean }

export function mapEmbed(html: string, kind: "playlist" | "album", id: string): ImportedPlaylist {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new SpotifyError("Could not read the Spotify page. Add a Spotify client id/secret in Admin → Music → Settings for reliable imports.");
  let data: unknown;
  try { data = JSON.parse(m[1]); } catch { throw new SpotifyError("Unexpected Spotify page format."); }
  const pageProps = (data as { props?: { pageProps?: { state?: { data?: { entity?: Record<string, unknown> } } } } }).props?.pageProps;
  const entity = pageProps?.state?.data?.entity as { name?: string; title?: string; subtitle?: string; coverArt?: { sources?: { url: string }[] }; trackList?: EmbedTrack[] } | undefined;
  if (!entity?.trackList) throw new SpotifyError("This playlist is private or could not be read.", 404);
  const tracks: ImportedTrack[] = [];
  for (const t of entity.trackList) {
    if (!t.title) continue;
    tracks.push({ externalId: t.uri?.split(":").pop(), title: t.title, artist: (t.subtitle ?? "").replace(/ /g, " ").trim() || "Unknown artist", durationSec: t.duration ? Math.round(t.duration / 1000) : undefined });
  }
  return { kind, sourceId: id, name: entity.name || entity.title || (kind === "album" ? "Spotify album" : "Spotify playlist"), artworkUrl: entity.coverArt?.sources?.[0]?.url, tracks, truncated: tracks.length >= 100, via: "embed" };
}

async function viaEmbed(kind: "playlist" | "album", id: string): Promise<ImportedPlaylist> {
  const r = await spfetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Rift/1.0)", "accept-language": "en" }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 404) throw new SpotifyError("Spotify could not find that playlist (or it is private).", 404);
  if (!r.ok) throw new SpotifyError(`Spotify returned ${r.status}`);
  return mapEmbed(await r.text(), kind, id);
}

export async function fetchSpotify(url: string): Promise<ImportedPlaylist> {
  const ref = parseSpotifyUrl(isShort(url.trim()) ? await expandShortLink(url.trim()) : url);
  if (!ref) throw new SpotifyError("That doesn't look like a Spotify playlist or album link.", 400);
  const s = await getSettings();
  if (s.spotifyClientId && s.spotifyClientSecret) {
    try { return await viaApi(ref.kind, ref.id, s.spotifyClientId, s.spotifyClientSecret); }
    catch (e) { if (!(e instanceof SpotifyError) || e.status === 404) throw e; /* API trouble: try the embed page */ }
  }
  return viaEmbed(ref.kind, ref.id);
}

// ---------- links: short links, several at once, a user's public playlists ----------
export type SpotifyRef = { kind: "playlist" | "album"; id: string } | { kind: "user"; id: string };

export function parseSpotifyRef(input: string): SpotifyRef | null {
  const pa = parseSpotifyUrl(input);
  if (pa) return pa;
  const s = input.trim();
  const m = /^spotify:user:([A-Za-z0-9._-]{1,64})$/.exec(s);
  if (m) return { kind: "user", id: m[1] };
  try {
    const u = new URL(s);
    if (u.hostname !== "open.spotify.com") return null;
    const x = /\/(?:intl-[a-z-]+\/)?user\/([A-Za-z0-9._-]{1,64})\/?$/.exec(u.pathname);
    return x ? { kind: "user", id: decodeURIComponent(x[1]) } : null;
  } catch { return null; }
}

/** Links in pasted text (the Spotify app shares "Listen to X on Spotify: https://…"). */
export function findSpotifyLinks(text: string): string[] {
  const found = text.match(/(?:https?:\/\/(?:open\.spotify\.com|spotify\.link|spoti\.fi)\/[^\s"'<>]+|spotify:(?:playlist|album|user):[A-Za-z0-9._-]+)/g) ?? [];
  return [...new Set(found.map((x) => x.replace(/[).,;]+$/, "")))].slice(0, 50);
}

const isShort = (url: string) => { try { return ["spotify.link", "spoti.fi"].includes(new URL(url).hostname); } catch { return false; } };

/** spotify.link / spoti.fi short links (what the phone app shares) -> the open.spotify.com link behind them. */
export async function expandShortLink(url: string): Promise<string> {
  if (!isShort(url)) return url;
  let cur = url;
  for (let i = 0; i < 4; i++) {
    const r = await spfetch(cur, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; Rift/1.0)" }, signal: AbortSignal.timeout(10_000) });
    const loc = r.headers.get("location");
    if (loc) {
      const next = new URL(loc, cur).toString();
      if (parseSpotifyRef(next)) return next;
      cur = next;
      continue;
    }
    // Branch links answer with a page that redirects in script: the target is in it.
    const html = await r.text().catch(() => "");
    const m = /https:\/\/open\.spotify\.com\/[a-z-/]*?(?:playlist|album|user)\/[A-Za-z0-9._-]+/.exec(html.replace(/\\\//g, "/"));
    if (m) return m[0];
    break;
  }
  throw new SpotifyError("Couldn't open that spotify.link short link. Open it in the browser and paste the open.spotify.com link instead.", 400);
}

export interface SpotifyListEntry { url: string; kind: "playlist" | "album"; id: string; name?: string; tracks?: number; owner?: string; artworkUrl?: string | null }

/** A user's public playlists (needs the Web API: a client id/secret). */
export async function userPlaylists(userId: string): Promise<SpotifyListEntry[]> {
  const s = await getSettings();
  if (!s.spotifyClientId || !s.spotifyClientSecret) throw new SpotifyError("Importing every playlist of a Spotify profile needs a Spotify client id/secret (Admin → Music → Settings). Paste the playlists' own links instead.", 400);
  const token = await apiToken(s.spotifyClientId, s.spotifyClientSecret);
  const out: SpotifyListEntry[] = [];
  let url: string | null = `https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists?limit=50`;
  while (url && out.length < 200) {
    const r = await spfetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404) throw new SpotifyError("Spotify has no profile with that link.", 404);
    if (!r.ok) throw new SpotifyError(`Spotify API error ${r.status}`);
    const page = (await r.json()) as { next: string | null; items: ({ id: string; name: string; tracks?: { total?: number }; owner?: { display_name?: string }; images?: { url: string }[] } | null)[] };
    for (const p of page.items) if (p?.id) out.push({ url: `https://open.spotify.com/playlist/${p.id}`, kind: "playlist", id: p.id, name: p.name, tracks: p.tracks?.total, owner: p.owner?.display_name, artworkUrl: p.images?.[0]?.url ?? null });
    url = page.next;
  }
  return out;
}

export interface PreviewItem { input: string; entries: SpotifyListEntry[]; error?: string; user?: string }

/** What a paste would import: each link resolved (short links expanded, profiles expanded to their playlists). */
export async function previewSpotify(text: string): Promise<PreviewItem[]> {
  const links = findSpotifyLinks(text);
  if (!links.length) throw new SpotifyError("No Spotify playlist, album or profile link found. Copy the link from Spotify (Share → Copy link) and paste it here.", 400);
  return Promise.all(links.map(async (input): Promise<PreviewItem> => {
    try {
      const url = await expandShortLink(input);
      const ref = parseSpotifyRef(url);
      if (!ref) return { input, entries: [], error: /\/track\//.test(url) ? "That's a song link. Rift imports playlists and albums: share the playlist instead." : "Not a playlist, album or profile link." };
      if (ref.kind === "user") return { input, user: ref.id, entries: await userPlaylists(ref.id) };
      return { input, entries: [{ url: `https://open.spotify.com/${ref.kind}/${ref.id}`, kind: ref.kind, id: ref.id }] };
    } catch (e) { return { input, entries: [], error: (e as Error).message }; }
  }));
}
