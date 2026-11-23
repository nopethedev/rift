import { db } from "@/server/db";
import { route, HttpError } from "@/server/api";
import { markCompanionSeen, snapshot } from "@/server/presence";

/** Read by the companion script on the user's PC. Authenticated by the profile's secret token only (no session). */
export const GET = route<{ token: string }>("none", async ({ params }) => {
  const token = params.token;
  const p = /^rp_[A-Za-z0-9_-]{20,64}$/.test(token) ? await db.profile.findUnique({ where: { presenceToken: token }, select: { id: true, name: true } }) : null;
  if (!p) throw new HttpError(404, "Unknown or revoked presence token");
  markCompanionSeen(p.id);
  return { profile: p.name, ...(await snapshot(p.id)) };
}, { rate: { key: "presence", max: 90, windowMs: 60_000 } });
