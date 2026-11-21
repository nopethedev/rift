import "server-only";
import { getSettings } from "@/server/settings";
import { reconcileLibrary, scanDirectory, type ScanProgress, type ScanReport } from "./importer";

const RESCAN_EVERY = 10 * 60 * 1000;
const BOOT_DELAY = 5_000;

export interface ScanStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  progress: ScanProgress | null;
  /** Reports of the last completed scan (one per directory). */
  lastReports: ScanReport[];
  lastReconcile: { checked: number; missing: number; restored: number } | null;
  lastError: string | null;
  nextScanAt: string | null;
}

interface ScannerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  current: Promise<ScanReport[]> | null;
  status: ScanStatus;
}

const g = globalThis as unknown as { __riftScanner?: ScannerState };
const state: ScannerState = (g.__riftScanner ??= {
  started: false,
  timer: null,
  current: null,
  status: { running: false, startedAt: null, finishedAt: null, progress: null, lastReports: [], lastReconcile: null, lastError: null, nextScanAt: null },
});

/**
 * Scan the given directories (default: settings.libraryDirs). Never overlaps: while a scan runs, callers get
 * the running scan's promise.
 */
export function scanNow(dirs?: string[]): Promise<ScanReport[]> {
  if (state.current) return state.current;
  state.current = (async () => {
    const st = state.status;
    st.running = true;
    st.startedAt = new Date().toISOString();
    st.lastError = null;
    const reports: ScanReport[] = [];
    try {
      const list = dirs?.length ? dirs : (await getSettings()).libraryDirs;
      try {
        st.lastReconcile = await reconcileLibrary();
      } catch (e) {
        st.lastError = `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      for (const dir of [...new Set(list)]) {
        reports.push(await scanDirectory(dir, { onProgress: (p) => (st.progress = p) }));
      }
      st.lastReports = reports;
    } catch (e) {
      st.lastError = e instanceof Error ? e.message : String(e);
      console.error("[library] scan failed:", st.lastError);
    } finally {
      st.running = false;
      st.progress = null;
      st.finishedAt = new Date().toISOString();
      state.current = null;
    }
    return reports;
  })();
  return state.current;
}

export function getScanStatus(): ScanStatus {
  return { ...state.status, lastReports: [...state.status.lastReports] };
}

/** Start the boot scan + periodic rescan (idempotent). */
export function startLibraryWatcher(): void {
  if (state.started) return;
  state.started = true;
  const schedule = () => (state.status.nextScanAt = new Date(Date.now() + RESCAN_EVERY).toISOString());
  const boot = setTimeout(() => {
    void scanNow().catch(() => {});
    schedule();
  }, BOOT_DELAY);
  boot.unref?.();
  state.timer = setInterval(() => {
    schedule();
    if (!state.current) void scanNow().catch(() => {});
  }, RESCAN_EVERY);
  state.timer.unref?.();
}

/** Stop the periodic rescan (a running scan finishes on its own). */
export function stopLibraryWatcher(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.status.nextScanAt = null;
}
