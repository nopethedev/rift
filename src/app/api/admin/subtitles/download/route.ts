import { z } from "zod";
import { body, route } from "@/server/api";
import { attachSubtitle } from "@/server/subtitle-service";

/** Download a search result and attach it to the file (converted to WebVTT). */
export const POST = route("admin", async ({ req }) => {
  const d = await body(req, z.object({
    fileId: z.string().min(1).max(64), osFileId: z.number().int().positive(), language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
    release: z.string().max(200).optional(), hearingImpaired: z.boolean().optional(),
  }));
  const r = await attachSubtitle(d.fileId, d.osFileId, d.language, d.release, d.hearingImpaired);
  return { ok: true, subtitle: { id: r.subtitle.id, label: r.subtitle.label, language: r.subtitle.language }, remaining: r.remaining };
}, { rate: { key: "os-download", max: 20, windowMs: 60_000 } });
