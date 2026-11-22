import "server-only";

/** Starts long-lived background services (torrent manager, library watcher). Called once from instrumentation.ts. */
export async function bootServices() {
  const g = globalThis as unknown as { __riftBooted?: boolean };
  if (g.__riftBooted) return;
  g.__riftBooted = true;
  try {
    const { db } = await import("./db");
    // The schema may not exist yet on a brand-new install (db:setup runs before start, but be defensive).
    await db.setting.count();
    const { getTorrentManager } = await import("./torrents/manager");
    await getTorrentManager().init();
    const { getTorrentStreamer } = await import("./torrents/streamer");
    await getTorrentStreamer().init();
    const { startLibraryWatcher } = await import("./library/scanner");
    startLibraryWatcher();
    const { startMusicWatcher } = await import("./music/library");
    startMusicWatcher();
    const { resumeAiSubtitles } = await import("./subtitle-ai");
    await resumeAiSubtitles().catch(() => {});
    console.log("[rift] background services started");
  } catch (e) {
    g.__riftBooted = false;
    console.error("[rift] failed to start background services:", e);
  }
}
