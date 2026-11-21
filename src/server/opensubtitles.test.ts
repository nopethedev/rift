import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenSubtitles, OpenSubtitlesError, openSubtitlesHash, rankResults, type OsResult } from "./opensubtitles";

let server: http.Server;
let base = "";
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const json = (code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url!.startsWith("/file/")) { res.writeHead(200); return res.end("1\n00:00:01,000 --> 00:00:02,000\nHi\n"); }
      if (req.headers["api-key"] !== "KEY") return json(403, { message: "bad key" });
      if (req.url === "/login") return JSON.parse(body).password === "pw" ? json(200, { token: "TOK", status: 200 }) : json(401, { message: "invalid" });
      if (req.url!.startsWith("/subtitles")) {
        return json(200, { data: [
          { attributes: { language: "en", download_count: 10, release: "A", files: [{ file_id: 1, file_name: "a.srt" }] } },
          { attributes: { language: "en", download_count: 5, release: "B", moviehash_match: true, files: [{ file_id: 2, file_name: "b.srt" }] } },
          { attributes: { language: "en", files: [] } },
        ] });
      }
      if (req.url === "/download") {
        if (req.headers.authorization !== "Bearer TOK") return json(406, { message: "quota", remaining: 0 });
        return json(200, { link: `${base}/file/${JSON.parse(body).file_id}.srt`, file_name: "x.srt", remaining: 19 });
      }
      if (req.url!.startsWith("/file/")) { res.writeHead(200); return res.end("1\n00:00:01,000 --> 00:00:02,000\nHi\n"); }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("OpenSubtitles.com client", () => {
  it("searches with sorted lower-case params, api key + user agent, and ranks hash matches first", async () => {
    const os = new OpenSubtitles({ apiKey: "KEY", username: "u", password: "pw", baseUrl: base });
    const r = await os.search({ type: "episode", tmdbId: 1399, season: 1, episode: 2, languages: ["EN", "fr"], moviehash: "abc" });
    const call = seen.find((s) => s.url.startsWith("/subtitles"))!;
    expect(call.url).toBe("/subtitles?episode_number=2&languages=en%2Cfr&moviehash=abc&order_by=download_count&order_direction=desc&parent_tmdb_id=1399&season_number=1&type=episode");
    expect(call.headers["api-key"]).toBe("KEY");
    expect(call.headers["user-agent"]).toMatch(/^Rift/);
    expect(call.headers.authorization).toBe("Bearer TOK");
    expect(r.map((x) => x.fileId)).toEqual([2, 1]); // hash match first, entry without files dropped
  });
  it("downloads via the returned link", async () => {
    const os = new OpenSubtitles({ apiKey: "KEY", username: "u", password: "pw", baseUrl: base });
    const d = await os.download(7);
    expect(d.content.toString()).toContain("Hi");
    expect(d.remaining).toBe(19);
  });
  it("maps errors: bad key, bad login, quota", async () => {
    await expect(new OpenSubtitles({ apiKey: "nope", baseUrl: base }).search({ type: "movie", query: "x", languages: ["en"] })).rejects.toThrow(/rejected the credentials/);
    await expect(new OpenSubtitles({ apiKey: "KEY", username: "u", password: "bad", baseUrl: base }).test()).rejects.toBeInstanceOf(OpenSubtitlesError);
    await expect(new OpenSubtitles({ apiKey: "KEY", baseUrl: base }).download(1)).rejects.toThrow(/quota/);
  });
});

describe("hash + ranking", () => {
  it("computes the OpenSubtitles hash", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oshash-"));
    try {
      const zeros = path.join(dir, "z.bin");
      await writeFile(zeros, Buffer.alloc(200 * 1024));
      expect(await openSubtitlesHash(zeros)).toBe((200 * 1024).toString(16).padStart(16, "0")); // only the size contributes
      const buf = Buffer.alloc(200 * 1024);
      buf.writeBigUInt64LE(5n, 0);
      buf.writeBigUInt64LE(7n, buf.length - 8);
      const f = path.join(dir, "d.bin");
      await writeFile(f, buf);
      expect(await openSubtitlesHash(f)).toBe((200 * 1024 + 12).toString(16).padStart(16, "0"));
      const tiny = path.join(dir, "t.bin");
      await writeFile(tiny, "hi");
      expect(await openSubtitlesHash(tiny)).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("ranks trusted, human, non-SDH, popular", () => {
    const b: OsResult = { fileId: 0, language: "en", release: "", fileName: "", downloads: 0, hearingImpaired: false, hashMatch: false, trusted: false, aiTranslated: false, rating: 0, uploader: null };
    const r = rankResults([{ ...b, fileId: 1, downloads: 999, aiTranslated: true }, { ...b, fileId: 2, downloads: 1, trusted: true }, { ...b, fileId: 3, downloads: 50 }]);
    expect(r.map((x) => x.fileId)).toEqual([2, 3, 1]);
  });
});
