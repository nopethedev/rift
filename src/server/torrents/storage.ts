// Disk usage helpers (pure fs; no server-only so scripts/tests can use them).
import { readdir, lstat, statfs } from "node:fs/promises";
import path from "node:path";

export const GiB = 1024 ** 3;

/** Bytes actually used on disk below `dir` (allocated blocks, so sparse torrent files count correctly). */
export async function dirUsageBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          const st = await lstat(p);
          total += typeof st.blocks === "number" ? st.blocks * 512 : st.size;
        } catch { /* vanished */ }
      }
    }
  }
  return total;
}

/** Free bytes available to unprivileged users on the filesystem holding `dir` (nearest existing parent). */
export async function freeBytes(dir: string): Promise<number | null> {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
