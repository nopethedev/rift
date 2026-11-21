import type { CardItem } from "./types";

export const cardHref = (i: Pick<CardItem, "type" | "tmdbId" | "localId">) =>
  i.tmdbId ? `/title/${i.type}/${i.tmdbId}` : `/title/local/${i.localId}`;

/** Where the Play button leads, or null when the title isn't playable locally. */
export const playHref = (i: Pick<CardItem, "type" | "tmdbId" | "available" | "playFileId">) => {
  if (!i.available) return null;
  if (i.playFileId) return `/watch/${i.playFileId}`;
  return i.type === "tv" && i.tmdbId ? `/title/tv/${i.tmdbId}?play=1` : null;
};
