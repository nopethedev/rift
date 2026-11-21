import type { NextRequest } from "next/server";
import { getAuth } from "@/server/auth";
import { workerFetch } from "@/server/transcode";

export const dynamic = "force-dynamic";

const SAFE = /^[A-Za-z0-9_.-]+$/;

/** Authenticated pass-through of HLS playlists/segments produced by the FFmpeg worker. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ session: string; path: string[] }> }) {
  if (!(await getAuth())) return new Response("Unauthorized", { status: 401 });
  const { session, path } = await ctx.params;
  if (!SAFE.test(session) || path.some((p) => !SAFE.test(p) || p === "." || p === "..")) return new Response("Bad request", { status: 400 });
  let res: Response;
  try {
    res = await workerFetch(`/hls/${session}/${path.join("/")}`, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]) });
  } catch {
    return new Response("Transcoding worker unavailable", { status: 503 });
  }
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
