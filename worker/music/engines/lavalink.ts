// Engine B: Lavalink. The node searches; the audio is then fetched straight from the source's CDN (direct/, the extractor
// ported from Rift Solo). When that isn't possible, the node plays the track and the voice sink catches its "voice channel"
// audio, which needs a node that can reach the worker and takes as long as the song.
import type { Candidate, MusicConfig, TrackQuery } from "../../../shared/music-protocol";
import { MATCH_THRESHOLD, scoreCandidate } from "../../../shared/music-match";
import type { LavalinkNode, LavalinkPool, LavalinkTrack } from "../lavalink";
import type { VoiceSink } from "../voice-sink";
import { searchPrefixes, sourceAllowed } from "../../../shared/lavalink-search";
import { EngineError, type AudioSource, type Engine } from "./types";
import { DIRECT_SOURCES, MIRRORED_SOURCES, directEnabled, extractBest, openDirect } from "../direct";

export function lavalinkEngine(pool: LavalinkPool, getSink: () => VoiceSink | null): Engine {
  const toCandidate = (n: LavalinkNode, t: LavalinkTrack): Candidate => ({
    engine: "lavalink",
    sourceId: `lavalink:${t.info.sourceName}:${t.info.identifier}`,
    title: t.info.title,
    artist: t.info.author,
    durationSec: t.info.length / 1000,
    url: t.info.uri ?? "",
    score: 0,
    artworkUrl: t.info.artworkUrl ?? undefined,
    encoded: t.encoded,
    nodeId: n.cfg.id,
    sourceName: t.info.sourceName,
  });

  // Searching only needs a node; the voice sink is only needed to play what the CDN extractor can't.
  const usable = (cfg: MusicConfig) => {
    pool.sync(cfg.lavalink.nodes);
    const nodes = pool.ordered();
    if (!nodes.length) throw new EngineError("No Lavalink nodes are configured", "unavailable");
    return nodes;
  };
  const direct = (c: Candidate) => {
    const src = (c.sourceName ?? "").toLowerCase();
    return directEnabled() && (DIRECT_SOURCES.has(src) || MIRRORED_SOURCES.has(src));
  };
  const allowed = (cfg: MusicConfig, c: Candidate) => sourceAllowed(cfg.lavalink.allowedSources, c.sourceName);

  // A pasted direct link is loaded as-is (Lavalink's "http" source).
  const loadUrl = (n: LavalinkNode, url: string) => n.load(url).then((r) => (r.loadType === "track" ? [r.data as LavalinkTrack] : r.loadType === "playlist" ? (r.data as { tracks: LavalinkTrack[] }).tracks : []));
  // Anything else goes through the node's search prefix(es). Several prefixes are searched at once and merged, so a node
  // that can search SoundCloud, YouTube, Spotify... isn't limited to one of them; one prefix failing doesn't hide the rest.
  async function prefixed(n: LavalinkNode, text: string, cfg: MusicConfig): Promise<LavalinkTrack[]> {
    const prefixes = searchPrefixes(n.cfg.searchPrefix, cfg.lavalink.allowedSources);
    const settled = await Promise.allSettled(prefixes.map((p) => n.search(p, text)));
    if (settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    const lists = settled.map((r) => (r.status === "fulfilled" ? r.value.filter((t) => !t.info.isStream) : []));
    const seen = new Set<string>();
    const out: LavalinkTrack[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) { const t = l[i]; if (t && !seen.has(t.encoded)) { seen.add(t.encoded); out.push(t); } }
    return out;
  }

  async function searchNodes(text: string, cfg: MusicConfig): Promise<Candidate[]> {
    let lastErr: Error | undefined;
    for (const n of usable(cfg)) {
      try {
        await n.waitReady(4000);
        const tracks = /^https?:\/\//i.test(text) ? await loadUrl(n, text) : await prefixed(n, text, cfg);
        return tracks.filter((t) => !t.info.isStream).map((t) => toCandidate(n, t)).filter((c) => allowed(cfg, c));
      } catch (e) { lastErr = e as Error; }
    }
    throw new EngineError(lastErr?.message ?? "No Lavalink node reachable", "unavailable");
  }

  return {
    id: "lavalink",

    async search(text, cfg, limit) {
      return (await searchNodes(text, cfg)).slice(0, limit).map((c, i) => ({ ...c, score: 1 - i * 0.02 }));
    },

    async resolve(query: TrackQuery, cfg) {
      const found = await searchNodes(`${query.artist} ${query.title}`.trim(), cfg);
      const ranked = found
        .map((c) => ({ ...c, score: scoreCandidate(query, { title: c.title, artist: c.artist, durationSec: c.durationSec }).score }))
        .filter((c) => c.score >= MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      if (!ranked.length) throw new EngineError(`No recording of "${query.title}" by ${query.artist} matched closely enough`, "not-found");
      return ranked;
    },

    async open(c, cfg): Promise<AudioSource> {
      usable(cfg);
      if (!allowed(cfg, c)) throw new EngineError(`Source "${c.sourceName}" is not enabled for Lavalink playback`, "unlicensed");
      let directErr: EngineError | undefined;
      if (direct(c)) {
        try {
          const a = await extractBest(c);
          console.log(`[music] ${c.sourceId}: direct from the CDN (${a.via})`);
          return openDirect(a);
        } catch (e) {
          directErr = e instanceof EngineError ? e : new EngineError((e as Error).message);
          console.warn(`[music] ${c.sourceId}: CDN extractor failed, trying the voice sink: ${directErr.message}`);
        }
      }
      const sink = getSink();
      if (!sink) throw directErr ?? new EngineError("The Lavalink audio bridge (voice sink) is not running on the worker", "unavailable");
      if (!c.encoded) throw new EngineError("Candidate has no Lavalink track data", "failed");
      const node = pool.get(c.nodeId) && pool.get(c.nodeId)!.online ? pool.get(c.nodeId)! : pool.ordered().find((n) => n.online);
      if (!node) throw new EngineError("No Lavalink node is online", "unavailable");

      const ticket = sink.createTicket();
      let finish!: () => void;
      let fail!: (e: Error) => void;
      const done = new Promise<void>((res, rej) => { finish = res; fail = rej; });
      done.catch(() => {});
      const onEvent = (m: { type?: string; guildId?: string; reason?: string; exception?: { message?: string } }) => {
        if (m.guildId !== ticket.guildId) return;
        if (m.type === "TrackEndEvent") {
          // Let the final RTP packets drain, then close the stream.
          setTimeout(() => { ticket.close(); m.reason === "finished" || m.reason === "stopped" ? finish() : fail(new EngineError(`Lavalink ended the track: ${m.reason}`)); }, 400).unref();
        } else if (m.type === "TrackExceptionEvent") {
          fail(new EngineError(explainTrackError(m.exception?.message ?? "the track failed", c.sourceName)));
          ticket.close();
        }
        // TrackStuckEvent is only a warning (no audio for a few seconds: YouTube buffering, a slow node). The track
        // usually carries on; if it really stops, Lavalink ends it or the cache's stall watchdog does. Treating it as fatal
        // used to restart the song on another recording half-way through.
      };
      node.on("event", onEvent);
      const cleanup = () => { node.off("event", onEvent); void node.destroy(ticket.guildId); };
      done.then(cleanup, cleanup);
      try {
        try {
          try { await node.play(ticket.guildId, c.encoded, ticket.voice); } catch (e) {
            // A one-off "Failed to connect to voice server" happens (busy node, two connections at once): try once more.
            if (!/voice server|voice connection/i.test((e as Error).message)) throw e;
            await new Promise((r) => setTimeout(r, 800));
            await node.play(ticket.guildId, c.encoded, ticket.voice);
          }
        } catch (e) {
          // The node accepted the request but could not open its voice connection to our bridge: it can't reach the worker
          // (a hosted / remote node usually can't: TCP 4443 + UDP 4444 on this machine) or doesn't trust the certificate.
          if (/voice server|voice connection/i.test((e as Error).message)) throw new EngineError(`The Lavalink node "${node.cfg.name ?? node.cfg.id}" can't connect to Rift's audio bridge. A node on another network (free hosted nodes) can search but can't play into this server; use the bundled node or yt-dlp. (${(e as Error).message.slice(0, 160)})`, "unavailable");
          throw e;
        }
        await Promise.race([ticket.connected, new Promise((_, rej) => setTimeout(() => rej(new EngineError("Lavalink never connected to the Rift voice sink. The node must be able to reach and trust it (see the README).", "unavailable")), 15_000).unref())]);
      } catch (e) {
        ticket.close();
        cleanup();
        throw e;
      }
      return { stream: ticket.stream, realtime: true, done, close: () => { ticket.close(); fail(new EngineError("closed")); } };
    },
  };
}

/** Lavalink's exception text -> what to change. YouTube failures almost always mean bot checks or signature deciphering. */
export function explainTrackError(msg: string, sourceName?: string): string {
  const yt = /youtube/i.test(sourceName ?? "") || /youtube/i.test(msg);
  if (yt && /sign in|log ?in|not a bot|bot|age.?restrict|confirm your age|requires login/i.test(msg))
    return `YouTube refused the node ("${msg.slice(0, 120)}"). Turn on the YouTube sign-in (burner account) or add a poToken under Admin → Music → Settings → Lavalink, write the config and restart lavalink.`;
  if (yt && /cipher|signature|sig function|decipher|n function|script/i.test(msg))
    return `YouTube changed its player and the node couldn't decipher the stream ("${msg.slice(0, 120)}"). Set a remote cipher server under Admin → Music → Settings → Lavalink (or update the youtube plugin), write the config and restart lavalink.`;
  if (yt && /all clients failed|no client|unavailable|403|forbidden/i.test(msg))
    return `None of the node's YouTube clients could play this ("${msg.slice(0, 120)}"). Update the youtube plugin, set a remote cipher server or turn on the sign-in.`;
  return `Lavalink: ${msg}`;
}
