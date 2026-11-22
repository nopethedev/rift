import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config";
import type { Candidate } from "@shared/music-protocol";

// On-demand candidates carry a source URL / Lavalink track blob that the worker will fetch. Clients may hold them (a search
// result they picked, a queued item) but must not be able to forge them: that would let any signed-in user point the
// server at arbitrary URLs. The server therefore signs every candidate it issues and accepts only its own signatures.

const key = () => createHmac("sha256", "rift-music-candidate-v1").update(env.workerToken).digest();
const payload = (c: Candidate) => [c.engine, c.sourceId, c.url, c.encoded ?? "", c.nodeId ?? "", c.sourceName ?? ""].join("\u0001");
const mac = (c: Candidate) => createHmac("sha256", key()).update(payload(c)).digest("base64url");

export type SealedCandidate = Candidate & { sig: string };

export const seal = (c: Candidate): SealedCandidate => ({ ...c, sig: mac(c) });

/** Returns the candidate when its signature is valid, otherwise null (the caller falls back to resolving by title/artist). */
export function unseal(raw: unknown): SealedCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as SealedCandidate;
  if (typeof c.sig !== "string" || typeof c.sourceId !== "string" || typeof c.url !== "string" || (c.engine !== "ytdlp" && c.engine !== "lavalink")) return null;
  const want = Buffer.from(mac(c)), got = Buffer.from(c.sig);
  return want.length === got.length && timingSafeEqual(want, got) ? c : null;
}
