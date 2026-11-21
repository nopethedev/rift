import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bdecode, buildMagnet, parseMagnet, parseTorrentFile, safePathSegment } from "./metainfo";

const bstr = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const pieces = "p".repeat(20);

function singleFile(name = "a.mkv", length = 5) {
  const info = `d6:lengthi${length}e4:name${bstr(name)}12:piece lengthi16384e6:pieces20:${pieces}e`;
  return { buf: Buffer.from(`d8:announce${bstr("http://t/announce")}4:info${info}e`), info };
}

function multiFile(paths: string[][], name = "Pack") {
  const files = paths.map((p, i) => `d6:lengthi${(i + 1) * 10}e4:pathl${p.map(bstr).join("")}ee`).join("");
  const info = `d5:filesl${files}e4:name${bstr(name)}12:piece lengthi16384e6:pieces20:${pieces}e`;
  return { buf: Buffer.from(`d4:info${info}e`), info };
}

describe("metainfo", () => {
  it("decodes bencode", () => {
    const { value } = bdecode(Buffer.from("d1:ai42e1:bl1:x1:yee"));
    expect((value as any).a).toBe(42);
    expect((value as any).b.map((b: Buffer) => b.toString())).toEqual(["x", "y"]);
  });

  it("parses a single-file torrent and computes the info hash", () => {
    const { buf, info } = singleFile();
    const m = parseTorrentFile(buf);
    expect(m.infoHash).toBe(createHash("sha1").update(info).digest("hex"));
    expect(m).toMatchObject({ name: "a.mkv", totalSize: 5, files: [{ index: 0, path: "a.mkv", size: 5 }] });
  });

  it("parses multi-file torrents and skips padding files", () => {
    const { buf } = multiFile([["S01", "e1.mkv"], [".pad", "123"], ["e2.mkv"]]);
    const m = parseTorrentFile(buf);
    expect(m.files).toEqual([
      { index: 0, path: "Pack/S01/e1.mkv", size: 10 },
      { index: 2, path: "Pack/e2.mkv", size: 30 },
    ]);
    expect(m.totalSize).toBe(60);
  });

  it("rejects path traversal", () => {
    expect(() => parseTorrentFile(multiFile([["..", "evil"]]).buf)).toThrow(/unsafe/);
    expect(() => parseTorrentFile(singleFile("../x").buf)).toThrow(/safe/);
  });

  it("rejects garbage", () => {
    expect(() => parseTorrentFile(Buffer.from("hello"))).toThrow();
    expect(() => parseTorrentFile(Buffer.from("d3:fooi1ee"))).toThrow(/info/);
  });

  it("parses magnets (hex, base32, bare hash)", () => {
    const hex = "c9e15763f722f23e98a29decdfae341b98d53056";
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=Foo%20Bar&tr=udp%3A%2F%2Ft%3A1`)).toEqual({ infoHash: hex, name: "Foo Bar", trackers: ["udp://t:1"] });
    expect(parseMagnet("magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW")?.infoHash).toBe(hex);
    expect(parseMagnet(hex)?.infoHash).toBe(hex);
    expect(parseMagnet("magnet:?xt=urn:sha1:abc")).toBeNull();
    expect(parseMagnet("http://example.com")).toBeNull();
    expect(parseMagnet(buildMagnet(hex, "x y", ["http://t/a"]))).toEqual({ infoHash: hex, name: "x y", trackers: ["http://t/a"] });
  });

  it("safePathSegment", () => {
    expect(safePathSegment("a/b")).toBe("a_b");
    expect(safePathSegment("..")).toBe("_");
    expect(safePathSegment("  ")).toBe("torrent");
  });
});
