// Integration test for src/server/library/importer.ts against real ffmpeg-generated files and a temp sqlite DB.
// Run: npx tsx --conditions=react-server scripts/test-importer.ts
import { writeFileSync, mkdirSync, rmSync, renameSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setupTestEnv, check, failed, makeVideo, SRT } from "./lib/test-env";
import { startFakeTmdb } from "./lib/fake-tmdb";

async function main() {
  const tmdbServer = await startFakeTmdb();
  const env = await setupTestEnv("importer", { TMDB_BASE_URL: tmdbServer.url });
  const { db } = env;
  const lib = path.join(env.mediaDir, "library");
  const srt = path.join(env.tmp, "sub.srt");
  writeFileSync(srt, SRT);

  // media fixtures
  const movie = path.join(lib, "Movies/Night.of.the.Living.Dead.1968.720p.BluRay.x264-GRP.mkv");
  makeVideo(movie, { srt }); // embedded SRT track
  writeFileSync(movie.replace(/\.mkv$/, ".en.srt"), SRT); // sidecar
  mkdirSync(path.join(path.dirname(movie), "Subs"), { recursive: true });
  writeFileSync(path.join(path.dirname(movie), "Subs", "French.srt"), SRT.replace("Hello", "Bonjour"));
  const ep1 = path.join(lib, "TV/Test Show/Season 1/Test.Show.S01E01.mkv");
  const ep2 = path.join(lib, "TV/Test Show/Season 1/Test Show - 1x02 - Second.mp4");
  makeVideo(ep1);
  makeVideo(ep2, { srt });
  const unknown = path.join(lib, "Random/Completely Unknown Thing 2011.mkv");
  makeVideo(unknown);
  const sample = path.join(lib, "Movies/Night.of.the.Living.Dead.1968-sample.mkv");
  makeVideo(sample, { seconds: 1 });
  writeFileSync(path.join(lib, "Movies/partial.mkv.part"), "x");

  const { updateSettings } = await import("../src/server/settings");
  const importer = await import("../src/server/library/importer");
  const scanner = await import("../src/server/library/scanner");

  console.log("1) TMDB not configured -> everything unmatched, no crash");
  await updateSettings({ tmdbApiKey: "", libraryDirs: [lib] });
  const r0 = await importer.importFile(unknown, { source: "import" });
  check(r0.status === "unmatched", `unmatched without TMDB (${r0.warnings.join("; ")})`);
  const row0 = await db.mediaFile.findUnique({ where: { id: r0.mediaFileId } });
  check(row0?.rawName === "Completely Unknown Thing 2011.mkv", "rawName stored");
  check(row0?.videoCodec === "h264" && row0?.width === 320 && (row0?.durationSec ?? 0) > 1.5, "probe columns stored");

  console.log("2) scan with fake TMDB");
  await updateSettings({ tmdbApiKey: "test" });
  const reports = await scanner.scanNow([lib]);
  const rep = reports[0];
  console.log("   report:", JSON.stringify({ ...rep, errors: rep.errors }));
  check(rep.found === 4, `found 4 videos (sample + .part skipped), got ${rep.found}`);
  check(rep.skippedExisting === 1, "already imported file skipped");
  check(rep.imported === 3 && rep.errors.length === 0, "3 new files imported without errors");

  const mv = await db.mediaFile.findUnique({ where: { path: movie }, include: { title: true, subtitles: true } });
  check(mv?.status === "ready" && mv.title?.tmdbId === 101 && mv.title.year === 1968, `movie matched to tmdb 101 (got ${mv?.title?.tmdbId})`);
  const subs = mv?.subtitles ?? [];
  check(subs.length === 3, `movie has 3 subtitles (sidecar, Subs/French, embedded) - got ${subs.length}: ${subs.map((s) => `${s.source}:${s.label}`).join(", ")}`);
  check(subs.every((s) => existsSync(s.path) && readFileSync(s.path, "utf8").startsWith("WEBVTT")), "subtitle VTT files exist");
  check(subs.some((s) => s.source === "embedded" && s.language === "eng"), "embedded subtitle extracted");
  check(subs.some((s) => s.language === "fr"), "Subs/French.srt detected as fr");

  const e1 = await db.mediaFile.findUnique({ where: { path: ep1 }, include: { episode: { include: { titleRef: true } } } });
  check(e1?.status === "ready" && e1.episode?.season === 1 && e1.episode.number === 1 && e1.episode.titleRef.tmdbId === 202, "S01E01 linked");
  check(e1?.episode?.name === "Episode 1 name", "episode metadata from season fetch");
  const e2 = await db.mediaFile.findUnique({ where: { path: ep2 }, include: { episode: true, subtitles: true } });
  check(e2?.status === "ready" && e2.episode?.number === 2, "1x02 linked");
  check((e2?.subtitles.length ?? 0) === 1, "mov_text subtitle extracted from mp4");
  const un = await db.mediaFile.findUnique({ where: { path: unknown } });
  check(un?.status === "unmatched", "unknown title stays unmatched");

  console.log("3) manual link + better-file rule");
  const linked = await importer.linkMediaFile(un!.id, { tmdbId: 202, mediaType: "tv", season: 1, episode: 3 });
  check(linked.status === "ready" && linked.match?.episode === 3, "manual link to S01E03");
  const better = path.join(lib, "TV/Test Show/Season 1/Test.Show.S01E01.1080p.mkv");
  makeVideo(better, { size: "640x480" });
  const rb = await importer.importFile(better, { source: "import" });
  const oldE1 = await db.mediaFile.findUnique({ where: { path: ep1 } });
  check(rb.status === "ready" && oldE1?.status === "unmatched" && oldE1.episodeId === null, "higher resolution file replaces the older one for the episode");

  console.log("4) hint import (upload path)");
  const up = path.join(env.mediaDir, "uploads/whatever.mkv");
  makeVideo(up);
  const ru = await importer.importFile(up, { source: "upload", hint: { tmdbId: 103, mediaType: "movie" } });
  check(ru.status === "ready" && ru.match?.tmdbId === 103 && ru.match.confidence === "hint", "hinted movie linked");
  const ru2 = await importer.importFile(path.join(env.mediaDir, "uploads/whatever.mkv"), { source: "upload", hint: { tmdbId: 999, mediaType: "movie" } });
  check(ru2.status === "ready" && ru2.warnings.some((w) => /TMDB 404/.test(w)), `bad hint keeps the earlier link and warns (${ru2.warnings.join("; ")})`);

  console.log("5) bad files");
  const bad = path.join(lib, "broken.mkv");
  writeFileSync(bad, "definitely not a video");
  let threw = "";
  try {
    await importer.importFile(bad, { source: "import" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(/Could not read media file/.test(threw), `broken file rejected: ${threw}`);
  rmSync(bad);

  console.log("6) reconcile missing / restored");
  const moved = movie + ".moved";
  renameSync(movie, moved);
  let rec = await importer.reconcileLibrary();
  check(rec.missing === 1 && (await db.mediaFile.findUnique({ where: { path: movie } }))?.status === "missing", "vanished file marked missing");
  renameSync(moved, movie);
  rec = await importer.reconcileLibrary();
  check(rec.restored === 1 && (await db.mediaFile.findUnique({ where: { path: movie } }))?.status === "ready", "returned file restored");

  console.log("7) registerSubtitleFile");
  const s = await importer.registerSubtitleFile(mv!.id, srt, { language: "de", source: "upload" });
  check(s.format === "srt" && s.label === "German" && existsSync(s.path), "uploaded subtitle registered");

  console.log("8) importDownload (tv hint, season default)");
  const dl = path.join(env.mediaDir, "downloads");
  const pack = path.join(dl, "Test.Show.S02.720p");
  makeVideo(path.join(pack, "Test.Show.S02E01.720p.mkv"));
  makeVideo(path.join(pack, "Episode 2.mkv"));
  const row = await db.download.create({
    data: {
      infoHash: "a".repeat(40), name: "Test.Show.S02.720p", status: "completed", savePath: pack, progress: 1, size: 0n,
      files: JSON.stringify([
        { index: 0, path: "Test.Show.S02.720p/Test.Show.S02E01.720p.mkv", size: 1, progress: 1 },
        { index: 1, path: "Test.Show.S02.720p/Episode 2.mkv", size: 1, progress: 1 },
        { index: 2, path: "Test.Show.S02.720p/readme.txt", size: 1, progress: 1 },
      ]),
      tmdbId: 202, mediaType: "tv", season: 2,
    },
  });
  const res = await importer.importDownload(row.id);
  const eps = res.results.map((r) => `${r.match?.season}x${r.match?.episode}`).sort();
  check(res.results.length === 2 && eps.join() === "2x1,2x2", `download mapped to S02E01, S02E02 (${eps.join()})`);
  check((await db.download.findUnique({ where: { id: row.id } }))?.status === "imported", "download marked imported");

  console.log("9) scan of a missing directory does not throw");
  const r9 = await importer.scanDirectory(path.join(env.tmp, "nope"));
  check(r9.errors.length === 1, "reported as error");

  await tmdbServer.close();
  await db.$disconnect();
  rmSync(env.tmp, { recursive: true, force: true });
  console.log(failed() ? `\n${failed()} check(s) FAILED` : "\nall importer checks passed");
  process.exit(failed() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
