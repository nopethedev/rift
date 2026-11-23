/** Lavalink searches by prefix ("scsearch:", "ytsearch:", ...). Which prefix belongs to which source (LavaSrc + built-ins). */
export const SOURCE_PREFIX: Record<string, string> = {
  soundcloud: "scsearch", youtube: "ytsearch", youtubemusic: "ytmsearch", spotify: "spsearch", applemusic: "amsearch",
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
    if (tok === "auto") for (const src of allowedSources) { const p = SOURCE_PREFIX[src.toLowerCase()]; if (p) add(p); }
    else if (/^[a-z]{2,20}$/.test(tok)) add(tok);
  }
  return (out.length ? out : ["scsearch"]).slice(0, MAX_PREFIXES);
}
