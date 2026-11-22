// Which remote image hosts the artwork proxy may contact (pure: unit-tested).
const BUILTIN_HOSTS = [/(^|\.)dzcdn\.net$/, /(^|\.)deezer\.com$/, /(^|\.)mzstatic\.com$/, /(^|\.)scdn\.co$/, /(^|\.)spotifycdn\.com$/, /^upload\.wikimedia\.org$/, /(^|\.)sndcdn\.com$/, /(^|\.)ytimg\.com$/, /(^|\.)ggpht\.com$/, /(^|\.)googleusercontent\.com$/];
const extraHosts = () => (process.env.MUSIC_ART_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/** Only well-known artwork CDNs (plus MUSIC_ART_HOSTS, for self-hosted mirrors): the proxy must never become a way to fetch arbitrary URLs. */
export function artUrlAllowed(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const extra = extraHosts();
  if (extra.includes(u.host.toLowerCase()) || extra.includes(host)) return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  if (u.protocol !== "https:") return null;
  return BUILTIN_HOSTS.some((re) => re.test(host)) ? u : null;
}

