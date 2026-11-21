import "server-only";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { HttpError } from "./api";
import { resolveTorrentSource, type TorrentSearchResult } from "./torrents/search";
import { TorrentError, isTorrentError } from "./torrents/errors";

export const magnetSchema = z.string().trim().max(8000).regex(/^magnet:\?.*xt=urn:(btih|btmh):/i, "Not a valid magnet link");

export const resultSchema: z.ZodType<TorrentSearchResult> = z.object({
  id: z.string().max(500),
  title: z.string().max(500),
  provider: z.string().max(100),
  seeds: z.number(),
  peers: z.number(),
  size: z.string().max(40),
  sizeBytes: z.number().optional(),
  magnet: z.string().max(8000).optional(),
  torrentUrl: z.string().max(2000).optional(),
  infoHash: z.string().max(80).optional(),
  time: z.string().max(100).optional(),
  desc: z.string().max(2000).optional(),
  raw: z.object({ provider: z.string().optional(), desc: z.string().optional(), link: z.string().optional(), id: z.string().optional(), identifier: z.string().optional() }).optional(),
});

export interface TorrentSourceInput { magnet?: string; torrentFile?: Buffer }

/**
 * Accepts JSON ({magnet} | {result}) or multipart (field `file` = .torrent, plus optional JSON fields) and returns the
 * resolved torrent source together with any extra fields.
 */
export async function readTorrentSource(req: NextRequest): Promise<{ source: TorrentSourceInput; fields: Record<string, unknown> }> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      const fields: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") { try { fields[k] = JSON.parse(v); } catch { fields[k] = v; } }
      if (!(file instanceof File)) {
        if (typeof fields.magnet === "string") return { source: { magnet: magnetSchema.parse(fields.magnet) }, fields };
        throw new HttpError(400, "Provide a .torrent file or a magnet link");
      }
      if (file.size > 5 * 1024 * 1024) throw new HttpError(413, ".torrent file too large");
      return { source: { torrentFile: Buffer.from(await file.arrayBuffer()) }, fields };
    }
    const json = (await req.json()) as Record<string, unknown>;
    if (typeof json.magnet === "string") return { source: { magnet: magnetSchema.parse(json.magnet) }, fields: json };
    if (json.result) return { source: await resolveTorrentSource(resultSchema.parse(json.result)), fields: json };
    throw new HttpError(400, "Provide a magnet link, a .torrent file or a search result");
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, e.issues[0]?.message ?? "Invalid input");
    if (isTorrentError(e)) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export function mapTorrentError(e: unknown): never {
  if (isTorrentError(e)) throw new HttpError(e.status, e.message);
  throw e;
}
