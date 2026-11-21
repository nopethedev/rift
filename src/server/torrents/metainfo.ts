// Pure .torrent / magnet helpers (no server-only / db imports; unit-testable and usable from scripts).
import { createHash } from "node:crypto";

export type BValue = number | Buffer | BValue[] | { [key: string]: BValue };

export interface TorrentFileEntry {
  index: number;
  path: string;
  size: number;
}

export interface TorrentMeta {
  infoHash: string;
  name: string;
  totalSize: number;
  /** Real files (BEP 47 padding files are omitted, indexes stay webtorrent-compatible). */
  files: TorrentFileEntry[];
}

/** Minimal bencode decoder that also reports the raw byte range of the top-level "info" dict. */
export function bdecode(buf: Buffer): { value: BValue; infoRange?: [number, number] } {
  let pos = 0;
  let infoRange: [number, number] | undefined;
  const fail = (msg: string): never => {
    throw new Error(`Invalid bencode at byte ${pos}: ${msg}`);
  };
  const readInt = (end: number) => {
    const s = buf.toString("ascii", pos, end);
    if (!/^-?\d+$/.test(s)) fail("bad integer");
    pos = end + 1;
    return Number(s);
  };
  const parse = (depth: number): BValue => {
    if (depth > 64) fail("nesting too deep");
    if (pos >= buf.length) fail("unexpected end");
    const c = buf[pos];
    if (c === 0x69 /* i */) {
      pos++;
      const end = buf.indexOf(0x65, pos);
      if (end < 0) fail("unterminated integer");
      return readInt(end);
    }
    if (c === 0x6c /* l */) {
      pos++;
      const list: BValue[] = [];
      while (buf[pos] !== 0x65) list.push(parse(depth + 1));
      pos++;
      return list;
    }
    if (c === 0x64 /* d */) {
      pos++;
      const dict: { [key: string]: BValue } = {};
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) fail("unterminated dict");
        const k = parse(depth + 1);
        if (!Buffer.isBuffer(k)) fail("dict key must be a string");
        const key = (k as Buffer).toString("utf8");
        const start = pos;
        dict[key] = parse(depth + 1);
        if (depth === 0 && key === "info") infoRange = [start, pos];
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, pos);
      if (colon < 0) fail("bad string length");
      const len = readInt(colon);
      if (len < 0 || pos + len > buf.length) fail("string out of range");
      const s = buf.subarray(pos, pos + len);
      pos += len;
      return s;
    }
    return fail(`unexpected byte 0x${c.toString(16)}`);
  };
  const value = parse(0);
  return { value, infoRange };
}

/** Reject path traversal / absolute paths inside torrents (webtorrent joins these onto the download dir). */
const isSafeSegment = (p: string) => p.length > 0 && p !== "." && p !== ".." && !/[/\\\0]/.test(p);

const str = (v: BValue | undefined) => (Buffer.isBuffer(v) ? v.toString("utf8") : undefined);
const isDict = (v: BValue | undefined): v is { [key: string]: BValue } => !!v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v);

/** Parse a .torrent file (v1 / hybrid). Throws on invalid input. */
export function parseTorrentFile(buf: Buffer): TorrentMeta {
  const { value, infoRange } = bdecode(buf);
  if (!isDict(value) || !isDict(value.info) || !infoRange) throw new Error("Not a torrent file (missing info dictionary)");
  const info = value.info;
  const name = str(info["name.utf-8"]) ?? str(info.name);
  if (!name) throw new Error("Torrent has no name");
  if (!isSafeSegment(name)) throw new Error("Torrent name is not a safe path");
  if (!Buffer.isBuffer(info.pieces) && !isDict(info["file tree"])) throw new Error("Torrent has no pieces");
  const infoHash = createHash("sha1").update(buf.subarray(infoRange[0], infoRange[1])).digest("hex");
  const files: TorrentFileEntry[] = [];
  let totalSize = 0;
  if (Array.isArray(info.files)) {
    info.files.forEach((f, index) => {
      if (!isDict(f) || typeof f.length !== "number") throw new Error("Invalid file entry in torrent");
      const parts = (Array.isArray(f["path.utf-8"]) ? f["path.utf-8"] : Array.isArray(f.path) ? f.path : []).map((p) => str(p) ?? "");
      if (!parts.length || !parts.every(isSafeSegment)) throw new Error("Torrent contains an unsafe file path");
      const attr = str(f.attr) ?? "";
      totalSize += f.length;
      const p = [name, ...parts].join("/");
      if (attr.includes("p") || parts[0] === ".pad") return; // BEP 47 padding
      files.push({ index, path: p, size: f.length });
    });
  } else {
    if (typeof info.length !== "number") throw new Error("Torrent has no length");
    totalSize = info.length;
    files.push({ index: 0, path: name, size: info.length });
  }
  return { infoHash, name, totalSize, files };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32ToHex(s: string): string | null {
  let bits = "";
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}

/** Parse a magnet URI; returns null if it has no BitTorrent v1 info hash. */
export function parseMagnet(uri: string): { infoHash: string; name?: string; trackers: string[] } | null {
  const s = uri.trim();
  if (!/^magnet:\?/i.test(s)) {
    // allow bare info hashes
    if (/^[a-f0-9]{40}$/i.test(s)) return { infoHash: s.toLowerCase(), trackers: [] };
    return null;
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(s.slice(s.indexOf("?") + 1));
  } catch {
    return null;
  }
  let infoHash: string | null = null;
  for (const xt of params.getAll("xt")) {
    const m = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (!m) continue;
    if (/^[a-f0-9]{40}$/i.test(m[1])) infoHash = m[1].toLowerCase();
    else if (m[1].length === 32) infoHash = base32ToHex(m[1]);
    if (infoHash) break;
  }
  if (!infoHash) return null;
  return { infoHash, name: params.get("dn") ?? undefined, trackers: params.getAll("tr") };
}

/** Build a magnet link for an info hash. */
export function buildMagnet(infoHash: string, name?: string, trackers: string[] = []): string {
  let m = `magnet:?xt=urn:btih:${infoHash}`;
  if (name) m += `&dn=${encodeURIComponent(name)}`;
  for (const t of trackers) m += `&tr=${encodeURIComponent(t)}`;
  return m;
}

/** Make a torrent name safe to use as a single path segment. */
export function safePathSegment(name: string): string {
  const s = name.replace(/[/\\\0]/g, "_").replace(/^\.+$/, "_").trim();
  return s || "torrent";
}
