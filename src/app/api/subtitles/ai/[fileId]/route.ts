import { z } from "zod";
import { route, body } from "@/server/api";
import { aiState, cancelAiSubtitles, startAiSubtitles } from "@/server/subtitle-ai";

export const dynamic = "force-dynamic";

/** Status of the automatic (AI) subtitles of one media file; the player polls this while they are generated. */
export const GET = route<{ fileId: string }>("profile", async ({ params, auth }) => aiState(params.fileId, auth.user));

/** Generate automatic subtitles (Whisper, on the worker). Starts at `startSec` (the viewer's position), then covers the rest. */
export const POST = route<{ fileId: string }>("profile", async ({ req, params, auth }) => {
  const b = await body(req, z.object({ translate: z.boolean().optional(), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional(), startSec: z.number().min(0).max(1_000_000).optional() }).default({}));
  return { subtitle: await startAiSubtitles(params.fileId, auth.user, b) };
}, { rate: { key: "ai-subs", max: 20, windowMs: 60_000 } });

export const DELETE = route<{ fileId: string }>("profile", async ({ params, auth }) => { await cancelAiSubtitles(params.fileId, auth.user); });
