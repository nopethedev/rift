"use client";
import { useMemo } from "react";
import { fmtBytes } from "@/lib/types";

export interface PreviewFile { index: number; path: string; size: number }
export interface Preview { infoHash: string; name: string; totalSize: number; files: PreviewFile[] }

export const fmtSpeed = (b: number) => `${fmtBytes(b)}/s`;
export const fmtEta = (s: number | null) => {
  if (s === null || !Number.isFinite(s)) return "∞";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};

const VIDEO = /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|wmv|flv|mpg|mpeg|ogv)$/i;
const SUB = /\.(srt|vtt|ass|ssa)$/i;

/** Checkbox tree of torrent files. Video + subtitle files are pre-selected by default. */
export function FileSelector({ files, selected, onChange }: { files: PreviewFile[]; selected: Set<number>; onChange: (s: Set<number>) => void }) {
  const total = useMemo(() => files.filter((f) => selected.has(f.index)).reduce((a, f) => a + f.size, 0), [files, selected]);
  const toggle = (i: number) => {
    const n = new Set(selected);
    if (n.has(i)) n.delete(i); else n.add(i);
    onChange(n);
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>{selected.size} of {files.length} files · {fmtBytes(total)}</span>
        <span className="flex gap-3">
          <button type="button" className="hover:text-white" onClick={() => onChange(new Set(files.map((f) => f.index)))}>All</button>
          <button type="button" className="hover:text-white" onClick={() => onChange(new Set(files.filter((f) => VIDEO.test(f.path) || SUB.test(f.path)).map((f) => f.index)))}>Video only</button>
          <button type="button" className="hover:text-white" onClick={() => onChange(new Set())}>None</button>
        </span>
      </div>
      <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-bg/60 text-sm">
        {files.map((f) => (
          <li key={f.index}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-white/5">
              <input type="checkbox" checked={selected.has(f.index)} onChange={() => toggle(f.index)} className="size-4 accent-violet-500" />
              <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
              <span className="shrink-0 text-xs text-muted">{fmtBytes(f.size)}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const defaultSelection = (files: PreviewFile[]) => {
  const vids = files.filter((f) => VIDEO.test(f.path) || SUB.test(f.path));
  return new Set((vids.length ? vids : files).map((f) => f.index));
};
