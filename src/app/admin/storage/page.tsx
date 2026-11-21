"use client";
import { HardDrive } from "lucide-react";
import { usePoll } from "@/lib/use-poll";
import { fmtBytes } from "@/lib/types";
import { Badge, Card, ProgressBar, Skeleton } from "@/components/ui";
import { PageHeader } from "../parts";

interface Storage {
  volumes: { path: string; exists: boolean; usedByRift: number; totalBytes: number; freeBytes: number; role: string[] }[];
  downloadLimitGB: number; downloadsUsedBytes: number;
  byStatus: { status: string; count: number; bytes: number }[];
  bySource: { source: string; count: number; bytes: number }[];
  largest: { id: string; name: string; size: number; status: string }[];
}

export default function StoragePage() {
  const { data, loading } = usePoll<Storage>("/api/admin/storage", 30000);
  return (
    <>
      <PageHeader title="Storage" subtitle="Disk usage of your library, uploads and downloads." />
      <div className="grid gap-4 lg:grid-cols-2">
        {loading && <><Skeleton className="h-36" /><Skeleton className="h-36" /></>}
        {data?.volumes.map((v) => {
          const used = v.totalBytes - v.freeBytes;
          return (
            <Card key={v.path}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="flex items-center gap-2 font-semibold"><HardDrive className="size-4 text-accent" /> <span className="truncate">{v.path}</span></p>
                  <div className="mt-1 flex gap-1">{v.role.map((r) => <Badge key={r} tone="accent">{r}</Badge>)}{!v.exists && <Badge tone="red">missing</Badge>}</div></div>
              </div>
              <ProgressBar value={v.totalBytes ? used / v.totalBytes : 0} />
              <p className="mt-2 text-sm text-muted">{fmtBytes(v.freeBytes)} free of {fmtBytes(v.totalBytes)} · Rift uses {fmtBytes(v.usedByRift)}</p>
            </Card>
          );
        })}
      </div>
      {data && (
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Card>
            <h3 className="mb-2 font-semibold">Download storage limit</h3>
            <p className="text-sm text-muted">{data.downloadLimitGB ? `${fmtBytes(data.downloadsUsedBytes)} of ${data.downloadLimitGB} GB used` : `${fmtBytes(data.downloadsUsedBytes)} used — no limit set`}</p>
            {data.downloadLimitGB > 0 && <ProgressBar className="mt-2" value={data.downloadsUsedBytes / (data.downloadLimitGB * 1e9)} />}
          </Card>
          <Card>
            <h3 className="mb-2 font-semibold">By source</h3>
            <ul className="space-y-1 text-sm">{data.bySource.map((s) => <li key={s.source} className="flex justify-between"><span className="capitalize">{s.source}</span><span className="text-muted">{s.count} files · {fmtBytes(s.bytes)}</span></li>)}</ul>
          </Card>
          <Card>
            <h3 className="mb-2 font-semibold">By status</h3>
            <ul className="space-y-1 text-sm">{data.byStatus.map((s) => <li key={s.status} className="flex justify-between"><span className="capitalize">{s.status}</span><span className="text-muted">{s.count} files · {fmtBytes(s.bytes)}</span></li>)}</ul>
          </Card>
        </div>
      )}
      {data && data.largest.length > 0 && (
        <Card className="mt-4">
          <h3 className="mb-3 font-semibold">Largest files</h3>
          <ul className="divide-y divide-line text-sm">{data.largest.map((f) => <li key={f.id} className="flex justify-between gap-4 py-2"><span className="truncate">{f.name}</span><span className="shrink-0 text-muted">{fmtBytes(f.size)}</span></li>)}</ul>
        </Card>
      )}
    </>
  );
}
