// Stand-in for Deezer, iTunes, Wikipedia and an artwork CDN so the E2E suite runs without internet. Serves fixtures shaped
// like the real APIs, plus /__stats (request counts) to verify caching. Usage: node fake-catalog.mjs <port> <workdir>
import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PORT = Number(process.argv[2] || 8098);
const B = `http://localhost:${PORT}`;
const jpg = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0xe11d48:s=500x500", "-frames:v", "1", "-f", "mjpeg", "pipe:1"]).stdout;
fs.writeFileSync(`${process.argv[3] || "/tmp"}/fake-cover.jpg`, jpg);
const stats = {};

const art = (n) => ({ picture_xl: `${B}/img/artist-${n}.jpg`, picture_big: `${B}/img/artist-${n}.jpg` });
const cov = (n) => ({ cover_xl: `${B}/img/cover-${n}.jpg`, cover_big: `${B}/img/cover-${n}.jpg` });
const A = {
  1: { id: 1, name: "Test Artist", nb_fan: 123456, nb_album: 3, ...art(1) },
  2: { id: 2, name: "Other Artist", nb_fan: 5400, nb_album: 1, ...art(2) },
  3: { id: 3, name: "Demo Artist", nb_fan: 9800000, nb_album: 2, picture_xl: "https://e-cdns-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg" },
};
const album = (id, title, ar, year, type, n = 10) => ({ id, title, artist: { id: ar, name: A[ar].name }, release_date: `${year}-05-01`, record_type: type, nb_tracks: n, ...cov(id) });
const ALB = { 11: album(11, "Test Album", 1, 2021, "album", 4), 12: album(12, "Test Album (Deluxe)", 1, 2022, "album"), 13: album(13, "Lone Single", 1, 2023, "single", 1), 14: album(14, "Demo Hits", 3, 2024, "album", 2) };
const trk = (id, title, ar, alb, dur) => ({ id, title, title_short: title, duration: dur, explicit_lyrics: false, artist: { id: ar, name: A[ar].name }, album: { id: alb, title: ALB[alb].title, ...cov(alb) } });
const T = [trk(101, "Alpha Track", 3, 14, 10), trk(102, "Beta Track", 3, 14, 10), trk(103, "Tone One", 1, 11, 14), trk(104, "Gamma Track", 2, 11, 10)];
const D = (arr) => ({ data: arr, total: arr.length });
const genres = D([{ id: 0, name: "All" }, { id: 132, name: "Pop", ...art(1) }, { id: 152, name: "Rock", ...art(2) }, { id: 113, name: "Rap/Hip Hop", ...art(1) }]);
const chart = (extra = {}) => ({ tracks: D(T), albums: D(Object.values(ALB)), artists: D(Object.values(A).filter((a) => a.id !== 3 || true)), playlists: D([]), ...extra });

const wiki = {
  Test_Artist: { type: "standard", title: "Test Artist", description: "American electronic band", extract: "Test Artist is an American electronic music band formed in 2010. ".repeat(12), content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Test_Artist" } } },
  Other_Artist: { type: "disambiguation", title: "Other Artist", extract: "Other Artist may refer to:" },
};

function route(u) {
  const p = u.pathname;
  if (p === "/chart/0" || /^\/chart\/\d+$/.test(p)) return chart();
  if (p === "/editorial/0/releases") return D([ALB[14], ALB[13]]);
  if (p === "/genre") return genres;
  if (p === "/search/artist") { const q = (u.searchParams.get("q") || "").replaceAll('"', "").toLowerCase(); return D(Object.values(A).filter((a) => a.name.toLowerCase().includes(q) || q.includes(a.name.toLowerCase()))); }
  if (p === "/search/album") {
    const q = u.searchParams.get("q") || "";
    if (/Singles/i.test(q)) return D([]); // forces the iTunes fallback
    return D(Object.values(ALB).filter((a) => q.toLowerCase().includes(a.title.toLowerCase())));
  }
  if (p === "/search/track") return D(T.filter((t) => (u.searchParams.get("q") || "").toLowerCase().includes(t.title.toLowerCase())));
  let m;
  if ((m = /^\/artist\/(\d+)$/.exec(p))) return A[m[1]] ?? { error: { type: "DataException", message: "no data", code: 800 } };
  if ((m = /^\/artist\/(\d+)\/top$/.exec(p))) return D(T.filter((t) => String(t.artist.id) === m[1]));
  if ((m = /^\/artist\/(\d+)\/albums$/.exec(p))) return D(Object.values(ALB).filter((a) => String(a.artist.id) === m[1]).concat(m[1] === "1" ? [{ ...ALB[11], id: 99 }] : []));
  if ((m = /^\/artist\/(\d+)\/related$/.exec(p))) return D(Object.values(A).filter((a) => String(a.id) !== m[1]));
  if ((m = /^\/album\/(\d+)$/.exec(p))) return ALB[m[1]] ? { ...ALB[m[1]], label: "Rift Records", duration: 600, genres: D([{ id: 132, name: "Pop" }]), tracks: D(T.filter((t) => String(t.album.id) === m[1]).map(({ album, ...r }) => r)) } : { error: { type: "DataException", message: "no data", code: 800 } };
  return null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, B);
  stats[u.pathname] = (stats[u.pathname] ?? 0) + 1;
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (u.pathname === "/__stats") return send(200, stats);
  if (u.pathname === "/__down") { globalThis.down = u.searchParams.get("on") === "1"; return send(200, { down: globalThis.down }); }
  if (u.pathname.startsWith("/img/")) return send(200, jpg, "image/jpeg");
  if (globalThis.down) return send(503, { error: "down" });
  if (u.pathname === "/itunes/search") return send(200, { resultCount: 1, results: [{ collectionName: "Singles", artistName: "Other Artist", artworkUrl100: `${B}/img/100x100bb.jpg` }] });
  const wm = /^\/wiki\/api\/rest_v1\/page\/summary\/(.+)$/.exec(u.pathname);
  if (wm) { const w = wiki[decodeURIComponent(wm[1])]; return w ? send(200, w) : send(404, { title: "Not found" }); }
  const r = route(u);
  return r ? send(200, r) : send(404, { error: { type: "DataException", message: "not found", code: 800 } });
}).listen(PORT, "127.0.0.1", () => console.log(`fake catalog on ${B}`));
