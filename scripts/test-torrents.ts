// Integration test for src/server/torrents/manager.ts: a local HTTP tracker + a second WebTorrent client seeding
// real files on 127.0.0.1, exercised through the real TorrentManager, Prisma (temp sqlite) and the importer.
// Run: npx tsx --conditions=react-server scripts/test-torrents.ts
import { writeFileSync, existsSync, statSync, rmSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setupTestEnv, check, failed, makeVideo, waitFor } from "./lib/test-env";
import { startFakeTmdb } from "./lib/fake-tmdb";

const NO_NET = { dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, webSeeds: false };

async function main() {
  const tmdbServer = await startFakeTmdb();
  const env = await setupTestEnv("torrents", { TMDB_BASE_URL: tmdbServer.url });
  const { db } = env;

  // ---------- fixtures: a season pack (2 real episodes + junk) and a single-file torrent
  const seedRoot = path.join(env.tmp, "seed");
  const pack = path.join(seedRoot, "Test.Show.S01.720p-GRP");
  makeVideo(path.join(pack, "Test.Show.S01E01.720p.mkv"), { seconds: 12, size: "640x480" });
  makeVideo(path.join(pack, "Test.Show.S01E02.720p.mkv"), { seconds: 12, size: "640x480" });
  writeFileSync(path.join(pack, "extras.bin"), randomBytes(3 * 1024 * 1024));
  const single = path.join(seedRoot, "single", "Night.of.the.Living.Dead.1968.mkv");
  makeVideo(single, { seconds: 8, size: "640x480" });
  const big = path.join(seedRoot, "big", "Big.Random.Data.bin");
  mkdirSync(path.dirname(big), { recursive: true });
  writeFileSync(big, randomBytes(4 * 1024 * 1024));

  // ---------- local tracker + seeder
  const { Server } = (await import("bittorrent-tracker")) as unknown as { Server: new (o: object) => any };
  const tracker = new Server({ udp: false, ws: false, http: true, stats: false });
  await new Promise<void>((r) => tracker.listen(0, "127.0.0.1", () => r()));
  const trackerUrl = `http://127.0.0.1:${(tracker.http.address() as AddressInfo).port}/announce`;
  const { default: WebTorrent } = (await import("webtorrent")) as unknown as { default: new (o: object) => any };
  const seeder = new WebTorrent(NO_NET);
  seeder.on("error", (e: Error) => console.error("seeder error", e.message));
  const seed = (p: string) => new Promise<any>((r) => seeder.seed(p, { announce: [trackerUrl] }, (t: any) => r(t)));
  const packT = await seed(pack);
  const singleT = await seed(single);
  const bigT = await seed(big);
  console.log(`seeding ${packT.name} (${packT.infoHash}) and ${singleT.name}; tracker ${trackerUrl}`);

  const { updateSettings } = await import("../src/server/settings");
  const { TorrentManager, TorrentError } = await import("../src/server/torrents/manager");
  const downloadDir = path.join(env.mediaDir, "downloads");
  mkdirSync(downloadDir, { recursive: true });
  await updateSettings({
    tmdbApiKey: "test", downloadDir, libraryDirs: [env.mediaDir], autoImportDownloads: true,
    storageLimitGB: 0, maxActiveDownloads: 1, downloadLimitKBps: 0, uploadLimitKBps: 0,
  });

  let mgr = new TorrentManager({ clientOptions: NO_NET });
  await mgr.init();
  await mgr.init(); // idempotent

  console.log("1) metadata preview");
  const prevMagnet = await mgr.previewMetadata({ magnet: packT.magnetURI });
  check(prevMagnet.infoHash === packT.infoHash && prevMagnet.files.length === 3, `magnet preview: ${prevMagnet.files.map((f) => f.path).join(", ")}`);
  const prevFile = await mgr.previewMetadata({ torrentFile: Buffer.from(packT.torrentFile) });
  check(prevFile.totalSize === packT.length && prevFile.name === packT.name, "torrent-file preview (offline parse)");
  check(!existsSync(path.join(downloadDir, packT.name)), "preview wrote nothing to the download dir");

  console.log("2) validation errors");
  const err = async (p: Promise<unknown>) => p.then(() => null, (e) => e as InstanceType<typeof TorrentError>);
  const e1 = await err(mgr.add({ magnet: "magnet:?xt=urn:sha1:nope" }));
  check(e1 instanceof TorrentError && e1.status === 400, `invalid magnet -> 400 (${e1?.message})`);
  const e2 = await err(mgr.add({ torrentFile: Buffer.from("garbage") }));
  check(e2 instanceof TorrentError && e2.status === 400, `invalid torrent file -> 400 (${e2?.message})`);
  await updateSettings({ storageLimitGB: 0.001 }); // ~1 MB
  const e3 = await err(mgr.add({ magnet: packT.magnetURI }));
  check(e3 instanceof TorrentError && e3.status === 507, `over storage limit -> 507 (${e3?.message})`);
  await updateSettings({ storageLimitGB: 0 });
  if (!process.env.SKIP_SLOW) {
  const e4 = await err(mgr.previewMetadata({ magnet: "magnet:?xt=urn:btih:" + "b".repeat(40) }).catch((e) => { throw e; }));
  check(e4 instanceof TorrentError && e4.status === 504, `unreachable magnet -> 504 after 45 s (${e4?.message})`);
  }

  console.log("3) add with file selection (throttled so we can pause)");
  await updateSettings({ downloadLimitKBps: 120 });
  const extrasIdx = prevMagnet.files.find((f) => f.path.endsWith("extras.bin"))!.index;
  const wanted = prevMagnet.files.filter((f) => f.index !== extrasIdx).map((f) => f.index);
  const v = await mgr.add({ magnet: packT.magnetURI, selectedFiles: wanted, tmdbId: 202, mediaType: "tv", season: 1, createdBy: "test" });
  check(v.files.length === 3 && v.files.filter((f) => f.selected).length === 2, "view lists 3 files, 2 selected");
  check(v.size === prevMagnet.files.filter((f) => f.index !== extrasIdx).reduce((n, f) => n + f.size, 0), "size = selected bytes");
  const dup = await mgr.add({ magnet: packT.magnetURI });
  check(dup.id === v.id, "dedupe by infoHash");
  const v2 = await mgr.add({ torrentFile: Buffer.from(singleT.torrentFile), tmdbId: 101, mediaType: "movie" });
  check(v2.status === "queued", `second download queued (maxActiveDownloads=1): ${v2.status}`);

  const p1 = await waitFor(async () => {
    const d = await mgr.get(v.id);
    if (process.env.DEBUG_T) console.log(JSON.stringify({ ...d, files: undefined }));
    return d && d.progress > 0.15 && d.progress < 0.9 ? d : null;
  }, 60_000, "progress");
  check(p1.status === "downloading" && p1.downloadSpeed > 0 && p1.peers >= 1, `downloading: ${(p1.progress * 100).toFixed(0)}% @ ${(p1.downloadSpeed / 1024).toFixed(0)} KB/s, ${p1.peers} peer(s), eta ${p1.eta}s`);
  check(p1.downloadSpeed < 400 * 1024, "download throttle applied");

  console.log("4) pause / resume");
  const paused = await mgr.pause(v.id);
  check(paused.status === "paused" && !mgr.isActive(v.id), "paused and detached from the client");
  await new Promise((r) => setTimeout(r, 2500));
  const still = await mgr.get(v.id);
  check(Math.abs((still?.progress ?? 0) - paused.progress) < 0.001 && paused.progress > 0, `progress frozen while paused (${(paused.progress * 100).toFixed(1)}%)`);
  const v2b = await mgr.get(v2.id);
  check(v2b?.status !== "queued", `pausing freed the slot for the queued download (${v2b?.status})`);
  const resumed = await mgr.resume(v.id);
  check(resumed.status === "downloading" || resumed.status === "metadata" || resumed.status === "queued", `resumed (${resumed.status})`);
  await waitFor(async () => ((await mgr.get(v.id))?.progress ?? 0) > paused.progress + 0.05, 30_000, "progress after resume");
  check(true, "progress continues after resume");

  console.log("5) persistence across a manager restart");
  const before = (await mgr.get(v.id))!;
  await mgr.shutdown();
  const row = await db.download.findUnique({ where: { id: v.id } });
  check(row && row.progress > 0 && Number(row.downloaded) > 0 && row.files && row.torrentPath && existsSync(row.torrentPath), `progress persisted (${(row!.progress * 100).toFixed(0)}%) + .torrent saved`);
  await updateSettings({ downloadLimitKBps: 0 });
  mgr = new TorrentManager({ clientOptions: NO_NET });
  await mgr.init();
  const after = (await mgr.get(v.id))!;
  check(after.status === "downloading" || after.status === "metadata", `resumed automatically after restart (${after.status})`);

  const done = await waitFor(async () => {
    const d = await mgr.get(v.id);
    return d && (d.status === "imported" || d.status === "error") ? d : null;
  }, 90_000, "completion + import");
  check(done.status === "imported", `completed and auto-imported (${done.status}${done.error ? ": " + done.error : ""})`);
  check(done.progress === 1 && done.completedAt && before.progress < 1, "progress 1, completedAt set");
  const extrasPath = path.join(downloadDir, prevMagnet.files[extrasIdx].path);
  const extrasSize = existsSync(extrasPath) ? statSync(extrasPath).blocks * 512 : 0;
  check(extrasSize < 3 * 1024 * 1024, `deselected file not downloaded (${extrasSize} bytes on disk)`);
  const files = await db.mediaFile.findMany({ where: { source: "torrent", path: { contains: packT.name } }, include: { episode: true } });
  check(files.length === 2 && files.every((f) => f.status === "ready" && f.episode?.season === 1), `2 episodes linked: ${files.map((f) => `S${f.episode?.season}E${f.episode?.number}`).join(", ")}`);

  console.log("6) continuous storage-limit enforcement");
  const done2 = await waitFor(async () => {
    const d = await mgr.get(v2.id);
    return d && (d.status === "imported" || d.status === "error") ? d : null;
  }, 60_000, "second completion");
  check(done2.status === "imported" && !done2.error, `second download imported (${done2.status} ${done2.error ?? ""})`);
  const movie = await db.mediaFile.findFirst({ where: { path: { endsWith: "Night.of.the.Living.Dead.1968.mkv" } }, include: { title: true } });
  check(movie?.title?.tmdbId === 101, "movie hint linked");
  await updateSettings({ downloadLimitKBps: 40 });
  const v3 = await mgr.add({ torrentFile: Buffer.from(bigT.torrentFile) });
  await waitFor(async () => ((await mgr.get(v3.id))?.downloaded ?? 0) > 0, 30_000, "third download started");
  const paused3 = await mgr.pause(v3.id);
  check(paused3.status === "paused", "third paused");
  await mgr.shutdown();
  mgr = new TorrentManager({ clientOptions: NO_NET });
  await mgr.init();
  check((await mgr.get(v3.id))?.status === "paused", "paused download stays paused after restart");
  await mgr.resume(v3.id);
  await updateSettings({ storageLimitGB: 0.000001 });
  const limited = await waitFor(async () => {
    const d = await mgr.get(v3.id);
    return d?.status === "error" ? d : null;
  }, 25_000, "storage limit error");
  check(/Storage limit/.test(limited.error ?? "") && !mgr.isActive(v3.id), `paused with error: ${limited.error}`);
  const e5 = await err(mgr.resume(v3.id));
  check(e5 instanceof TorrentError && e5.status === 507, "resume refused while over the limit");
  await updateSettings({ storageLimitGB: 0, downloadLimitKBps: 0 });
  await mgr.resume(v3.id);
  const done3 = await waitFor(async () => {
    const d = await mgr.get(v3.id);
    return d && (d.status === "error" || d.status === "imported" || d.status === "completed") ? d : null;
  }, 60_000, "third completion");
  // no video inside -> the auto import fails, files are kept
  check(done3.status === "error" && /Import failed/.test(done3.error ?? "") && done3.progress === 1, `non-video download completes, import error kept: ${done3.error}`);

  console.log("7) selection change + remove with files");
  const sel = await mgr.setSelectedFiles(v.id, [extrasIdx]);
  check(sel.files.find((f) => f.index === extrasIdx)?.selected === true && ["queued", "metadata", "downloading"].includes(sel.status), `re-selecting a file re-queues a finished download (${sel.status})`);
  await mgr.pause(v.id).catch(() => {});
  await mgr.remove(v.id, { deleteFiles: true });
  check(!existsSync(path.join(downloadDir, packT.name)), "files and folder deleted");
  check(!(await db.download.findUnique({ where: { id: v.id } })), "row deleted");
  check((await db.mediaFile.findMany({ where: { source: "torrent", status: "missing" } })).length === 2, "imported files of the removed download marked missing");
  const list = await mgr.list();
  check(list.length === 2 && list.some((d) => d.id === v2.id), "list() returns remaining downloads");
  const json = JSON.parse(JSON.stringify(list[0]));
  check(typeof json.size === "number" && typeof json.createdAt === "string", "DownloadView is JSON-safe");

  await mgr.shutdown();
  await new Promise<void>((r) => seeder.destroy(() => r()));
  await new Promise<void>((r) => tracker.close(() => r()));
  await tmdbServer.close();
  await db.$disconnect();
  rmSync(env.tmp, { recursive: true, force: true });
  console.log(failed() ? `\n${failed()} check(s) FAILED` : "\nall torrent checks passed");
  process.exit(failed() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
