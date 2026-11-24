/** Lavalink searches by prefix ("scsearch:", "ytsearch:", ...). Which prefix belongs to which source (LavaSrc + built-ins). */
export const SOURCE_PREFIX: Record<string, string | string[]> = {
  // YouTube Music first: real songs with clean titles/artists (the youtube-source plugin's MUSIC client), then videos.
  soundcloud: "scsearch", youtube: ["ytmsearch", "ytsearch"], youtubemusic: "ytmsearch", spotify: "spsearch", applemusic: "amsearch",
  deezer: "dzsearch", bandcamp: "bcsearch", yandexmusic: "ymsearch", tidal: "tdsearch", vkmusic: "vksearch",
};

const MAX_PREFIXES = 6;

/**
 * The prefixes a node is searched with. The node's "search prefix" field may hold one (`scsearch`), several separated by
 * commas or spaces (`ytsearch, scsearch, spsearch`), or `auto` = one prefix per allowed source that has one. Empty = scsearch.
 */
export function searchPrefixes(setting: string | undefined, allowedSources: string[] = []): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (!out.includes(p)) out.push(p); };
  for (const tok of (setting ?? "").toLowerCase().split(/[\s,;]+/).filter(Boolean)) {
    if (tok === "auto") for (const src of allowedSources) { const p = SOURCE_PREFIX[src.toLowerCase()]; if (p) [p].flat().forEach(add); }
    else if (/^[a-z]{2,20}$/.test(tok)) add(tok);
  }
  return (out.length ? out : ["scsearch"]).slice(0, MAX_PREFIXES);
}

/** Is a track from this Lavalink source allowed? YouTube Music results report sourceName "youtube", so either name allows both. */
export function sourceAllowed(allowedSources: string[], sourceName: string | undefined): boolean {
  if (!sourceName) return true;
  const allowed = allowedSources.map((s) => s.toLowerCase());
  const n = sourceName.toLowerCase();
  if (allowed.includes(n)) return true;
  return (n === "youtube" || n === "youtubemusic") && (allowed.includes("youtube") || allowed.includes("youtubemusic"));
}
