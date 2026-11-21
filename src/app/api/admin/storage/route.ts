import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { db } from "@/server/db";
import { route } from "@/server/api";
import { getSettings } from "@/server/settings";

async function dirSize(dir: string, budget = { files: 200_000 }): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files-- <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p, budget);
    else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export const GET = route("admin", async () => {
  const s = await getSettings();
  const dirs = [...new Set([...s.libraryDirs, s.downloadDir, s.uploadDir])];
  const volumes = await Promise.all(
    dirs.map(async (d) => {
      const fsStat = await statfs(d).catch(() => null);
      return {
        path: d,
        exists: !!fsStat,
        usedByRift: await dirSize(d),
        totalBytes: fsStat ? Number(fsStat.blocks) * Number(fsStat.bsize) : 0,
        freeBytes: fsStat ? Number(fsStat.bavail) * Number(fsStat.bsize) : 0,
        role: [s.libraryDirs.includes(d) && "library", d === s.downloadDir && "downloads", d === s.uploadDir && "uploads"].filter(Boolean) as string[],
      };
    }),
  );
  const [byStatus, bySource, top] = await Promise.all([
    db.mediaFile.groupBy({ by: ["status"], _count: true, _sum: { size: true } }),
    db.mediaFile.groupBy({ by: ["source"], _count: true, _sum: { size: true } }),
    db.mediaFile.findMany({ orderBy: { size: "desc" }, take: 10, select: { id: true, path: true, size: true, status: true } }),
  ]);
  return {
    volumes,
    downloadLimitGB: s.storageLimitGB,
    downloadsUsedBytes: await dirSize(s.downloadDir),
    byStatus: byStatus.map((r) => ({ status: r.status, count: r._count, bytes: Number(r._sum.size ?? 0) })),
    bySource: bySource.map((r) => ({ source: r.source, count: r._count, bytes: Number(r._sum.size ?? 0) })),
    largest: top.map((f) => ({ id: f.id, name: path.basename(f.path), size: Number(f.size), status: f.status })),
  };
});
