import { z } from "zod";
import { db } from "@/server/db";
import { route, body } from "@/server/api";
import { getSettings } from "@/server/settings";
import { clearNow, companionSeenAt, dropPresenceCfg, newToken, presenceCfg, snapshot } from "@/server/presence";

async function state(profileId: string) {
  const cfg = await presenceCfg(profileId);
  const s = await getSettings();
  const seen = companionSeenAt(profileId);
  return { available: !!s.discordClientId, token: cfg.token, music: cfg.music, stream: cfg.stream, companionSeenAt: seen, showing: cfg.token ? (await snapshot(profileId)).activity : null };
}

export const GET = route("profile", async ({ profile }) => state(profile.id));

export const PUT = route("profile", async ({ req, profile }) => {
  const b = await body(req, z.object({ music: z.boolean().optional(), stream: z.boolean().optional() }));
  await db.profile.update({ where: { id: profile.id }, data: { ...(b.music !== undefined ? { presenceMusic: b.music } : {}), ...(b.stream !== undefined ? { presenceStream: b.stream } : {}) } });
  dropPresenceCfg(profile.id);
  return state(profile.id);
});

/** Creates (or replaces) the secret token: the old companion stops working. */
export const POST = route("profile", async ({ profile }) => {
  await db.profile.update({ where: { id: profile.id }, data: { presenceToken: newToken() } });
  dropPresenceCfg(profile.id);
  return state(profile.id);
});

export const DELETE = route("profile", async ({ profile }) => {
  await db.profile.update({ where: { id: profile.id }, data: { presenceToken: null } });
  dropPresenceCfg(profile.id);
  clearNow(profile.id);
  return state(profile.id);
});
