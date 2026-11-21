import "server-only";
import { getSettings } from "@/server/settings";
import { TorrentError } from "./errors";
import { buildMagnet, parseMagnet, parseTorrentFile } from "./metainfo";

export interface TorrentSearchResult {
  id: string;
  title: string;
  provider: string;
  seeds: number;
  peers: number;
  /** Human readable size, e.g. "1.4 GB". */
  size: string;
  sizeBytes?: number;
  magnet?: string;
  torrentUrl?: string;
  infoHash?: string;
  time?: string;
  /** Details page URL. */
  desc?: string;
  /** Small, JSON-serializable data needed by resolveTorrentSource. */
  raw?: { provider?: string; desc?: string; link?: string; id?: string; identifier?: string };
}

export interface SearchProviderInfo {
  name: string;
  kind: "scraper" | "torznab" | "archive";
  enabled: boolean;
  /** Needs configuration (credentials / URL) before it can be used. */
  requiresConfig: boolean;
  categories: string[];
}

export interface ProviderSearchStatus {
  name: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface SearchOptions {
  category?: "movies" | "tv" | "all";
  limit?: number;
}

const PROVIDER_TIMEOUT = 12_000;
const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
export const INTERNET_ARCHIVE = "Internet Archive";
export const TORZNAB = "Torznab";
const archiveBase = () => (process.env.ARCHIVE_ORG_URL || "https://archive.org").replace(/\/$/, "");
const UA = "Mozilla/5.0 (compatible; Rift media server)";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// ------------------------------------------------------------------------------------------- sizes

const UNITS: Record<string, number> = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 };

/** "1.4 GB" / "700 MiB" / "1,234.5 MB" -> bytes (decimal units are treated as binary, as most trackers do). */
export function parseSize(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = /([\d.,]+)\s*([kmgt]i?b|b|bytes?)\b/i.exec(s.replace(/ /g, " "));
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ""));
  let unit = m[2].toLowerCase();
  if (unit.startsWith("byte")) unit = "b";
  const mult = UNITS[unit.replace(/^([kmgt])b$/, "$1ib")] ?? UNITS[unit];
  return Number.isFinite(n) && mult ? Math.round(n * mult) : undefined;
}

export function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ------------------------------------------------------------------------------------------- query helper

/** Build a search query: "Show Name S01E02", "Show Name S01", "Movie Name 2019". */
export function buildSearchQuery(q: { title: string; year?: number | null; mediaType: "movie" | "tv"; season?: number | null; episode?: number | null }): string {
  const title = q.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (q.mediaType === "movie") return q.year ? `${title} ${q.year}` : title;
  if (q.season !== undefined && q.season !== null) {
    return q.episode !== undefined && q.episode !== null ? `${title} S${pad(q.season)}E${pad(q.episode)}` : `${title} S${pad(q.season)}`;
  }
  return title;
}

// ------------------------------------------------------------------------------------------- torrent-search-api

interface TsaTorrent {
  title?: string;
  provider?: string;
  seeds?: number;
  peers?: number;
  size?: string;
  time?: string;
  magnet?: string;
  desc?: string;
  link?: string;
  id?: string | number;
}
interface TsaApi {
  getProviders(): { name: string; public: boolean; categories: string[] }[];
  enableProvider(name: string): void;
  isProviderActive(name: string): boolean;
  search(providers: string[], query: string, category: string, limit: number): Promise<TsaTorrent[]>;
  getMagnet(t: TsaTorrent): Promise<string>;
}

let tsaPromise: Promise<TsaApi | null> | null = null;
function loadTsa(): Promise<TsaApi | null> {
  return (tsaPromise ??= import("torrent-search-api")
    .then((m: { default?: TsaApi } & TsaApi) => (m.default ?? m) as TsaApi)
    .catch((e) => {
      console.error("[search] torrent-search-api failed to load:", errMsg(e));
      tsaPromise = null;
      return null;
    }));
}

function tsaCategory(categories: string[], c: SearchOptions["category"]): string {
  const has = (n: string) => categories.find((x) => x.toLowerCase() === n.toLowerCase());
  if (c === "movies") return has("Movies") ?? has("Video") ?? has("All") ?? categories[0] ?? "All";
  if (c === "tv") return has("TV") ?? has("Video") ?? has("All") ?? categories[0] ?? "All";
  return has("All") ?? categories[0] ?? "All";
}

async function searchScraper(api: TsaApi, name: string, query: string, opts: SearchOptions): Promise<TorrentSearchResult[]> {
  const info = api.getProviders().find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!info) throw new Error("unknown provider");
  if (!info.public) throw new Error("provider needs an account (not supported)");
  if (!api.isProviderActive(info.name)) api.enableProvider(info.name);
  const limit = opts.limit ?? 40;
  const rows = await withTimeout(api.search([info.name], query, tsaCategory(info.categories, opts.category), limit), PROVIDER_TIMEOUT, info.name);
  const out: TorrentSearchResult[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.title) continue;
    // some scrapers return a "No results" placeholder row
    if (/^no results/i.test(r.title)) continue;
    const magnet = typeof r.magnet === "string" && r.magnet.startsWith("magnet:") ? r.magnet : undefined;
    const infoHash = magnet ? parseMagnet(magnet)?.infoHash : undefined;
    const sizeBytes = parseSize(r.size);
    out.push({
      id: `${info.name}:${infoHash ?? r.id ?? r.desc ?? r.title}`,
      title: String(r.title).trim(),
      provider: info.name,
      seeds: Number(r.seeds) || 0,
      peers: Number(r.peers) || 0,
      size: r.size ? String(r.size) : humanSize(sizeBytes),
      sizeBytes,
      magnet,
      infoHash,
      time: r.time ? String(r.time) : undefined,
      desc: typeof r.desc === "string" ? r.desc : undefined,
      raw: {
        provider: info.name,
        desc: typeof r.desc === "string" ? r.desc : undefined,
        link: typeof r.link === "string" ? r.link : undefined,
        id: r.id !== undefined ? String(r.id) : undefined,
      },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- Torznab

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

const xmlAttr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeXml(m[2] ?? m[3] ?? "") : undefined;
};
const xmlText = (block: string, tag: string) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeXml(m[1]) : undefined;
};

export interface TorznabItem {
  title: string;
  guid?: string;
  link?: string;
  comments?: string;
  pubDate?: string;
  size?: number;
  seeders?: number;
  peers?: number;
  magnet?: string;
  infoHash?: string;
}

/** Parse a Torznab (RSS) response. Throws on a Torznab <error> response. */
export function parseTorznab(xml: string): TorznabItem[] {
  const err = /<error\b[^>]*>/i.exec(xml);
  if (err && !/<item\b/i.test(xml)) throw new Error(xmlAttr(err[0], "description") ?? "Torznab error");
  const items: TorznabItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const attrs: Record<string, string> = {};
    for (const a of b.matchAll(/<(?:torznab|newznab):attr\b[^>]*>/gi)) {
      const n = xmlAttr(a[0], "name");
      const v = xmlAttr(a[0], "value");
      if (n && v !== undefined) attrs[n.toLowerCase()] = v;
    }
    const enc = /<enclosure\b[^>]*>/i.exec(b)?.[0];
    const title = xmlText(b, "title");
    if (!title) continue;
    const link = xmlText(b, "link") ?? (enc ? xmlAttr(enc, "url") : undefined);
    const size = Number(attrs.size ?? xmlText(b, "size") ?? (enc ? xmlAttr(enc, "length") : undefined)) || undefined;
    let magnet = attrs.magneturl;
    if (!magnet && link?.startsWith("magnet:")) magnet = link;
    const infoHash = (attrs.infohash?.toLowerCase().match(/^[a-f0-9]{40}$/)?.[0]) ?? (magnet ? parseMagnet(magnet)?.infoHash : undefined);
    items.push({
      title,
      guid: xmlText(b, "guid"),
      link: link && !link.startsWith("magnet:") ? link : undefined,
      comments: xmlText(b, "comments"),
      pubDate: xmlText(b, "pubDate"),
      size,
      seeders: attrs.seeders !== undefined ? Number(attrs.seeders) : undefined,
      peers: attrs.peers !== undefined ? Number(attrs.peers) : undefined,
      magnet,
      infoHash,
    });
  }
  return items;
}

function torznabEndpoint(base: string): URL {
  const u = new URL(base);
  if (!/\/api\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, "/api");
  return u;
}

async function searchTorznab(url: string, apiKey: string, query: string, opts: SearchOptions): Promise<TorrentSearchResult[]> {
  const u = torznabEndpoint(url);
  u.searchParams.set("t", "search");
  u.searchParams.set("q", query);
  if (apiKey) u.searchParams.set("apikey", apiKey);
  if (opts.category === "movies") u.searchParams.set("cat", "2000");
  else if (opts.category === "tv") u.searchParams.set("cat", "5000");
  u.searchParams.set("limit", String(opts.limit ?? 50));
  const res = await fetch(u, { headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": UA }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT) });
  const text = await res.text();
  if (!res.ok) {
    const desc = /<error\b[^>]*>/i.exec(text)?.[0];
    throw new Error(`HTTP ${res.status}${desc ? `: ${xmlAttr(desc, "description") ?? ""}` : ""}`);
  }
  return parseTorznab(text).map((it, i) => {
    const seeds = it.seeders ?? 0;
    return {
      id: `${TORZNAB}:${it.infoHash ?? it.guid ?? i}`,
      title: it.title,
      provider: TORZNAB,
      seeds,
      peers: it.peers !== undefined ? Math.max(0, it.peers - seeds) : 0,
      size: humanSize(it.size),
      sizeBytes: it.size,
      magnet: it.magnet,
      infoHash: it.infoHash,
      torrentUrl: it.link,
      time: it.pubDate,
      desc: it.comments,
      raw: { provider: TORZNAB, link: it.link },
    };
  });
}

// ------------------------------------------------------------------------------------------- Internet Archive

async function searchArchive(query: string, opts: SearchOptions): Promise<TorrentSearchResult[]> {
  const cleaned = query.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const u = new URL(archiveBase() + "/advancedsearch.php");
  u.searchParams.set("q", `title:(${cleaned}) AND mediatype:(movies)`);
  for (const f of ["identifier", "title", "item_size", "downloads", "year", "publicdate", "licenseurl"]) u.searchParams.append("fl[]", f);
  u.searchParams.append("sort[]", "downloads desc");
  u.searchParams.set("rows", String(Math.min(opts.limit ?? 30, 50)));
  u.searchParams.set("page", "1");
  u.searchParams.set("output", "json");
  const res = await fetch(u, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { response?: { docs?: Record<string, unknown>[] } };
  const out: TorrentSearchResult[] = [];
  for (const d of data.response?.docs ?? []) {
    const id = typeof d.identifier === "string" ? d.identifier : null;
    if (!id || !/^[\w.-]+$/.test(id)) continue;
    const title = Array.isArray(d.title) ? String(d.title[0]) : String(d.title ?? id);
    const sizeBytes = Number(d.item_size) || undefined;
    const year = Number(d.year) || undefined;
    out.push({
      id: `${INTERNET_ARCHIVE}:${id}`,
      title: year && !title.includes(String(year)) ? `${title} (${year})` : title,
      provider: INTERNET_ARCHIVE,
      // archive.org torrents are web-seeded by archive.org itself, so they are always available
      seeds: 0,
      peers: 0,
      size: humanSize(sizeBytes),
      sizeBytes,
      torrentUrl: `${archiveBase()}/download/${id}/${id}_archive.torrent`,
      time: typeof d.publicdate === "string" ? d.publicdate : undefined,
      desc: `${archiveBase()}/details/${id}`,
      raw: { provider: INTERNET_ARCHIVE, identifier: id },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- public API

/** Every provider Rift knows about, with whether it is enabled in settings. */
export async function listSearchProviders(): Promise<SearchProviderInfo[]> {
  const s = await getSettings();
  const enabled = new Set(s.torrentSearchProviders.map((n) => n.toLowerCase()));
  const api = await loadTsa();
  const scrapers: SearchProviderInfo[] = (api?.getProviders() ?? []).map((p) => ({
    name: p.name,
    kind: "scraper",
    enabled: p.public && enabled.has(p.name.toLowerCase()),
    requiresConfig: !p.public,
    categories: p.categories,
  }));
  return [
    { name: INTERNET_ARCHIVE, kind: "archive", enabled: true, requiresConfig: false, categories: ["Movies"] },
    { name: TORZNAB, kind: "torznab", enabled: !!s.torznabUrl, requiresConfig: !s.torznabUrl, categories: ["Movies", "TV", "All"] },
    ...scrapers,
  ];
}

export async function searchTorrentsDetailed(query: string, opts: SearchOptions = {}): Promise<{ results: TorrentSearchResult[]; providers: ProviderSearchStatus[] }> {
  const q = query.trim().slice(0, 200);
  if (!q) throw new TorrentError("Search query is empty", 400);
  const s = await getSettings();
  const tasks: { name: string; run: () => Promise<TorrentSearchResult[]> }[] = [];
  tasks.push({ name: INTERNET_ARCHIVE, run: () => searchArchive(q, opts) });
  if (s.torznabUrl) tasks.push({ name: TORZNAB, run: () => searchTorznab(s.torznabUrl, s.torznabApiKey, q, opts) });
  const wanted = [...new Set(s.torrentSearchProviders.map((n) => n.trim()).filter(Boolean))];
  if (wanted.length) {
    const api = await loadTsa();
    for (const name of wanted) {
      tasks.push({
        name,
        run: async () => {
          if (!api) throw new Error("torrent-search-api is not available");
          return searchScraper(api, name, q, opts);
        },
      });
    }
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const start = Date.now();
      try {
        const r = await withTimeout(t.run(), PROVIDER_TIMEOUT + 1000, t.name);
        return { name: t.name, results: r, ms: Date.now() - start };
      } catch (e) {
        throw Object.assign(new Error(errMsg(e)), { provider: t.name, ms: Date.now() - start });
      }
    }),
  );
  const providers: ProviderSearchStatus[] = [];
  const all: TorrentSearchResult[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      providers.push({ name: r.value.name, ok: true, count: r.value.results.length, ms: r.value.ms });
      all.push(...r.value.results);
    } else {
      const e = r.reason as Error & { ms?: number };
      providers.push({ name: tasks[i].name, ok: false, count: 0, ms: e.ms ?? 0, error: errMsg(e).slice(0, 300) });
    }
  });
  return { results: mergeResults(all, opts.limit ?? 100), providers };
}

export async function searchTorrents(query: string, opts: SearchOptions = {}): Promise<TorrentSearchResult[]> {
  return (await searchTorrentsDetailed(query, opts)).results;
}

/** Dedupe by info hash (or normalized title + size) keeping the best-seeded entry; sort by seeds desc. */
export function mergeResults(results: TorrentSearchResult[], limit = 100): TorrentSearchResult[] {
  const byKey = new Map<string, TorrentSearchResult>();
  for (const r of results) {
    const key = r.infoHash
      ? `h:${r.infoHash}`
      : `t:${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}:${r.sizeBytes ? Math.round(r.sizeBytes / (1024 * 1024)) : r.size}`;
    const prev = byKey.get(key);
    if (!prev || r.seeds > prev.seeds || (r.seeds === prev.seeds && !prev.magnet && r.magnet)) byKey.set(key, r);
  }
  return [...byKey.values()].sort((a, b) => b.seeds - a.seeds || b.peers - a.peers || a.title.localeCompare(b.title)).slice(0, limit);
}

/** Download a .torrent (size capped). A redirect to a magnet link (Jackett does this) yields the magnet. */
async function fetchTorrentFile(url: string): Promise<{ magnet?: string; torrentFile?: Buffer }> {
  let cur = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (cur.protocol !== "http:" && cur.protocol !== "https:") throw new TorrentError("Unsupported torrent URL", 400);
    const res = await fetch(cur, { redirect: "manual", headers: { "user-agent": UA, accept: "application/x-bittorrent, */*" }, signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new TorrentError("Torrent download redirected without a location", 502);
      if (loc.startsWith("magnet:")) {
        if (!parseMagnet(loc)) throw new TorrentError("Invalid magnet link from provider", 502);
        return { magnet: loc };
      }
      cur = new URL(loc, cur);
      continue;
    }
    if (!res.ok) throw new TorrentError(`Torrent download failed: HTTP ${res.status}`, 502);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_TORRENT_BYTES) throw new TorrentError("Torrent file is too large", 413);
    const reader = res.body?.getReader();
    if (!reader) throw new TorrentError("Empty torrent download", 502);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TORRENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new TorrentError("Torrent file is too large", 413);
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    try {
      parseTorrentFile(buf);
    } catch (e) {
      throw new TorrentError(`Provider returned an invalid torrent file: ${errMsg(e)}`, 502);
    }
    return { torrentFile: buf };
  }
  throw new TorrentError("Too many redirects while downloading the torrent", 502);
}

/**
 * Turn a search result (as round-tripped through the browser) into something TorrentManager.add accepts.
 * URLs are rebuilt / checked server-side: archive.org from the identifier, Torznab only on the configured host.
 */
export async function resolveTorrentSource(result: TorrentSearchResult): Promise<{ magnet?: string; torrentFile?: Buffer }> {
  if (result.magnet) {
    if (!parseMagnet(result.magnet)) throw new TorrentError("Invalid magnet link", 400);
    return { magnet: result.magnet };
  }
  const provider = result.raw?.provider ?? result.provider;
  if (provider === INTERNET_ARCHIVE) {
    const id = result.raw?.identifier ?? result.id.replace(`${INTERNET_ARCHIVE}:`, "");
    if (!/^[\w.-]+$/.test(id)) throw new TorrentError("Invalid archive.org identifier", 400);
    return fetchTorrentFile(`${archiveBase()}/download/${id}/${id}_archive.torrent`);
  }
  if (provider === TORZNAB) {
    const s = await getSettings();
    const link = result.raw?.link ?? result.torrentUrl;
    if (!link) {
      if (result.infoHash) return { magnet: buildMagnet(result.infoHash, result.title) };
      throw new TorrentError("This result has no download link", 422);
    }
    if (!s.torznabUrl || new URL(link).origin !== new URL(s.torznabUrl).origin) throw new TorrentError("Download link does not belong to the configured Torznab server", 400);
    try {
      return await fetchTorrentFile(link);
    } catch (e) {
      if (result.infoHash) return { magnet: buildMagnet(result.infoHash, result.title) };
      throw e;
    }
  }
  // torrent-search-api scrapers: magnet from the details page
  const api = await loadTsa();
  if (!api) throw new TorrentError("torrent-search-api is not available", 503);
  const info = api.getProviders().find((p) => p.name === provider);
  if (!info) throw new TorrentError(`Unknown provider ${provider}`, 400);
  if (!api.isProviderActive(info.name)) api.enableProvider(info.name);
  let magnet: unknown;
  try {
    magnet = await withTimeout(
      api.getMagnet({ provider: info.name, title: result.title, desc: result.raw?.desc ?? result.desc, link: result.raw?.link, id: result.raw?.id }),
      15_000,
      `${info.name} magnet lookup`,
    );
  } catch (e) {
    if (result.infoHash) return { magnet: buildMagnet(result.infoHash, result.title) };
    throw new TorrentError(`Could not get the magnet link from ${info.name}: ${errMsg(e)}`, 502);
  }
  const m = Array.isArray(magnet) ? magnet[0] : magnet;
  if (typeof m !== "string" || !parseMagnet(m)) throw new TorrentError(`${info.name} did not return a magnet link`, 502);
  return { magnet: m };
}
