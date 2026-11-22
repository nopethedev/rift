import { readFile } from "node:fs/promises";
import { db } from "@/server/db";
import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Serves a converted WebVTT subtitle track. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getAuth())) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const sub = await db.subtitle.findUnique({ where: { id } });
  if (!sub) return new Response("Not found", { status: 404 });
  try {
    return new Response(await readFile(sub.path), {
      headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": sub.status === "generating" ? "private, no-store" : "private, max-age=3600" },
    });
  } catch {
    return new Response("Subtitle file missing", { status: 404 });
  }
}
