import { z } from "zod";
import { db } from "@/server/db";
import { route, body } from "@/server/api";
import { clearNow, presenceCfg, publicImage, setNow } from "@/server/presence";

/** The music player reports what it is playing (on track change, play/pause, seek and every 30 s) for Discord Rich Presence. */
export const POST = route("profile", async ({ req, profile }) => {
  const b = await body(req, z.object({ itemId: z.string().max(64).nullable(), position: z.number().min(0).max(100000).default(0), playing: z.boolean().default(true) }));
  const cfg = await presenceCfg(profile.id);
  if (!cfg.token || !cfg.music) return { enabled: false };
  if (!b.itemId) { clearNow(profile.id, "music"); return { enabled: true }; }
  const it = await db.musicQueueItem.findFirst({ where: { id: b.itemId, profileId: profile.id } });
  if (!it) { clearNow(profile.id, "music"); return { enabled: true }; }
  setNow(profile.id, { kind: "music", title: it.title, subtitle: it.artist ? `by ${it.artist}` : "Rift Music", album: it.album, image: publicImage(it.artworkUrl), position: b.position, duration: it.durationSec ?? 0, playing: b.playing });
  return { enabled: true };
});
