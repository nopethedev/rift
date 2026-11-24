"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../ui";
import { nextId } from "@/lib/music-queue";
import { artSrc, type EntryStatus, type ItemInput, MusicMode, PlayInfo, Queue, QueueItem, RepeatMode } from "@/lib/music-types";

interface PlayerCtx {
  queue: Queue | null;
  current: QueueItem | null;
  play: PlayInfo | null;
  playing: boolean;
  loading: boolean;
  position: number;
  duration: number;
  /** On-demand capture progress while the audio is still being fetched (0..1), null when not applicable. */
  capture: EntryStatus | null;
  error: string;
  volume: number;
  muted: boolean;
  /** Replace the queue and start playing. */
  playItems(items: ItemInput[], o?: { startIndex?: number; shuffle?: boolean; origin?: string }): Promise<void>;
  playQueueItem(id: string): Promise<void>;
  addToQueue(items: ItemInput[], where?: "end" | "next"): Promise<void>;
  playRadio(trackId: string): Promise<void>;
  playPlaylist(id: string, o?: { shuffle?: boolean; startItemId?: string }): Promise<void>;
  toggle(): void;
  next(): void;
  prev(): void;
  seek(t: number): void;
  setShuffle(v: boolean): void;
  setRepeat(v: RepeatMode): void;
  setAutoplay(v: boolean): void;
  setVolume(v: number): void;
  setMuted(v: boolean): void;
  removeFromQueue(id: string): Promise<void>;
  moveInQueue(id: string, toIndex: number): Promise<void>;
  clearQueue(): Promise<void>;
  mode: MusicMode | null;
}

const Ctx = createContext<PlayerCtx | null>(null);
export const useMusic = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("MusicProvider missing");
  return c;
};

const withStart = (url: string, at: number) => `${url}${url.includes("?") ? "&" : "?"}start=${Math.floor(at)}`;
const MAX_SKIPS = 8; // unplayable songs skipped in a row before giving up
const MAX_NET_RETRIES = 14; // ~2 minutes of backoff while the server cannot be reached
const isNetwork = (e: unknown) => !!(e as { network?: boolean }).network;

export function MusicProvider({ children }: { children: React.ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [play, setPlay] = useState<PlayInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [capture, setCapture] = useState<EntryStatus | null>(null);
  const [error, setError] = useState("");
  const [volume, setVolumeState] = useState(0.9);
  const [muted, setMutedState] = useState(false);
  const [mode, setMode] = useState<MusicMode | null>(null);
  const offset = useRef(0); // seconds the transcoded stream was started at
  const playRef = useRef<PlayInfo | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const skips = useRef(0);
  const retried = useRef<string | null>(null);
  const reported = useRef<string | null>(null);
  const later = useRef<{ timer: ReturnType<typeof setTimeout> | null; run: (() => void) | null }>({ timer: null, run: null });
  const netTries = useRef(0);
  const queueRef = useRef<Queue | null>(null);
  queueRef.current = queue;
  playRef.current = play;

  const current = useMemo(() => queue?.items.find((i) => i.id === queue.state.currentItemId) ?? null, [queue]);

  // ----- load persisted queue + mode, restore volume -----
  useEffect(() => {
    try { const v = Number(localStorage.getItem("rift.music.volume")); if (v >= 0 && v <= 1 && localStorage.getItem("rift.music.volume")) setVolumeState(v); setMutedState(localStorage.getItem("rift.music.muted") === "1"); } catch { /* private mode */ }
    api<Queue>("/api/music/queue").then(setQueue).catch(() => {});
    api<{ mode: MusicMode }>("/api/music/home").then((r) => setMode(r.mode)).catch(() => {});
  }, []);
  useEffect(() => { if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; } }, [volume, muted]);

  const caps = useCallback(() => {
    const a = document.createElement("audio");
    const can = (t: string) => !!a.canPlayType(t);
    return { opus: can('audio/ogg; codecs="opus"'), flac: can("audio/flac"), aac: can('audio/mp4; codecs="mp4a.40.2"') || can("audio/aac"), mp3: can("audio/mpeg"), vorbis: can('audio/ogg; codecs="vorbis"') };
  }, []);

  const report = useCallback((completed: boolean) => {
    const p = playRef.current;
    const a = audio.current;
    if (!p || !a || reported.current === p.item.id) return;
    const sec = offset.current + (a.currentTime || 0);
    reported.current = p.item.id;
    api("/api/music/history", { method: "POST", body: { itemId: p.item.id, playedSec: sec, completed, kind: p.kind } }).catch(() => {});
  }, []);

  // ----- Discord Rich Presence: tell the server what is playing (it ignores this unless the profile switched presence on) -----
  const presenceOff = useRef(0);
  const sentOnce = useRef(false);
  const sendPresence = useCallback(() => {
    if (Date.now() < presenceOff.current) return;
    const p = playRef.current;
    const a = audio.current;
    if (!p && !sentOnce.current) return;
    sentOnce.current = !!p;
    const body = p && a ? { itemId: p.item.id, position: offset.current + (a.currentTime || 0), playing: !a.paused } : { itemId: null, position: 0, playing: false };
    api<{ enabled: boolean }>("/api/music/presence", { method: "POST", body }).then((r) => { if (!r.enabled) presenceOff.current = Date.now() + 5 * 60_000; }).catch(() => {});
  }, []);

  // ----- loading a track into the <audio> element -----
  const attach = useCallback((p: PlayInfo, at: number) => {
    const a = audio.current;
    if (!a) return;
    offset.current = p.transcode ? at : 0;
    a.src = p.transcode ? withStart(p.url, at) : p.url;
    pendingSeek.current = !p.transcode && at > 0 ? at : null;
    setPosition(at);
    setDuration(p.durationSec ?? 0);
    void a.play().then(() => setPlaying(true)).catch((e: Error) => { if (e.name !== "AbortError") setPlaying(false); });
    queueMicrotask(sendPresence); // a restarted converted stream = a new position
  }, [sendPresence]);

  /** Runs `fn` after `ms`, or earlier when the connection / tab comes back (see the effect below). One pending action at most. */
  const schedule = useCallback((fn: () => void, ms: number) => {
    if (later.current.timer) clearTimeout(later.current.timer);
    later.current.run = fn;
    later.current.timer = setTimeout(() => { later.current.timer = null; later.current.run = null; fn(); }, ms);
  }, []);
  const cancelScheduled = useCallback(() => { if (later.current.timer) clearTimeout(later.current.timer); later.current.timer = null; later.current.run = null; }, []);
  const flash = useCallback((msg: string) => { setError(msg); setTimeout(() => setError((e) => (e === msg ? "" : e)), 7000); }, []);

  const lastSource = useRef<{ key: string; id: string } | null>(null);
  /** The next song, prepared ~30 s before this one ends, so `ended` can switch to it without waiting for the network. */
  const nextUp = useRef<{ afterId: string; play: PlayInfo } | null>(null);
  const peeking = useRef<string | null>(null);
  const peekAgainAt = useRef(0); // after a failed attempt: not before this time
  const startRef = useRef<(b: { itemId?: string; dir?: "next" | "prev"; auto?: boolean; forceTranscode?: boolean }, at?: number) => Promise<void>>(async () => {});

  /** The song after `id` according to the queue this tab holds (same rules as the server), or null at the end. */
  const after = useCallback((id: string, auto = false): string | null => {
    const q = queueRef.current;
    if (!q) return null;
    return nextId(q.items.map((i, position) => ({ id: i.id, position })), { currentItemId: id, repeat: q.state.repeat }, { auto });
  }, []);
  /** Can't play this song: say why and go on with the next one in the queue (a few times in a row at most). */
  const skipFrom = useCallback((failedId: string, title: string, why: string): boolean => {
    const q = queueRef.current;
    const nid = q ? after(failedId) : null; // repeat-one must not loop on a broken song: `auto` stays false
    if (!nid || nid === failedId || skips.current >= MAX_SKIPS) return false;
    skips.current++;
    flash(`Skipped “${title}”: ${why}`);
    schedule(() => void startRef.current({ itemId: nid }), 700);
    return true;
  }, [after, flash, schedule]);

  const start = useCallback(async (body: { itemId?: string; dir?: "next" | "prev"; auto?: boolean; forceTranscode?: boolean }, at = 0) => {
    cancelScheduled();
    setLoading(true);
    setError((e) => (e.startsWith("Skipped ") ? e : "")); // the "skipped" note stays while the next song loads (it clears itself)
    try {
      const r = await api<{ play: PlayInfo | null; queue: Queue; ended: boolean }>("/api/music/play", { method: "POST", body: { ...body, caps: caps() } });
      netTries.current = 0;
      setQueue(r.queue);
      if (r.ended || !r.play) { setPlay(null); setPlaying(false); setCapture(null); audio.current?.pause(); return; }
      reported.current = null;
      if (!retried.current?.startsWith(r.play.item.id)) retried.current = null; // new item: allow its own retry
      setPlay(r.play);
      setCapture(r.play.status ?? null);
      attach(r.play, at);
    } catch (e) {
      const msg = (e as Error).message;
      setPlaying(false);
      if (isNetwork(e)) {
        // Nothing is wrong with the song: the server could not be reached (offline, restarting, phone in the background). Keep trying
        // the same request with a growing pause; it is safe to repeat because it names the song (or is the end-of-queue step).
        if (netTries.current < MAX_NET_RETRIES) {
          const wait = Math.min(10_000, 1000 * 2 ** Math.min(netTries.current, 4));
          netTries.current++;
          setError("Can't reach the server. Retrying…");
          schedule(() => void startRef.current(body, at), wait);
        } else { netTries.current = 0; setError("Can't reach the server. Press play to try again."); }
        return;
      }
      // An unplayable item (not found, source refused, ...) is skipped; a limit / busy answer says nothing about this song, so it is shown instead.
      const failed = body.itemId ? queueRef.current?.items.find((i) => i.id === body.itemId) : undefined;
      if (failed && !/limit|try again/i.test(msg) && skipFrom(failed.id, failed.title, msg)) return;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [attach, caps, cancelScheduled, schedule, skipFrom]);
  startRef.current = start;

  // The connection (or the tab) came back: do the waiting retry now instead of at the end of its pause.
  useEffect(() => {
    const kick = () => { const f = later.current.run; if (!f || (document.visibilityState === "hidden")) return; cancelScheduled(); f(); };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", kick);
    return () => { window.removeEventListener("online", kick); document.removeEventListener("visibilitychange", kick); };
  }, [cancelScheduled]);

  /** Next song: named explicitly so a retry can never skip one; the server only decides at the end of the queue (autoplay). */
  const goNext = useCallback((auto: boolean) => {
    const cur = queueRef.current?.state.currentItemId;
    const nid = cur ? after(cur, auto) : null;
    void (nid ? start({ itemId: nid }) : start({ dir: "next", auto }));
  }, [after, start]);

  /** Prepare the song after the current one (once per song), without moving the queue. */
  const peek = useCallback(() => {
    const p = playRef.current;
    const q = queueRef.current;
    if (!p || !q || peeking.current === p.item.id || nextUp.current?.afterId === p.item.id || Date.now() < peekAgainAt.current) return;
    const nid = after(p.item.id, true);
    if (nid === p.item.id || (!nid && !q.state.autoplay)) return; // repeat-one / end of the queue: nothing to fetch
    peeking.current = p.item.id;
    api<{ play: PlayInfo | null; queue: Queue }>("/api/music/play", { method: "POST", body: { ...(nid ? { itemId: nid } : {}), peek: true, caps: caps() } })
      .then((r) => {
        if (playRef.current?.item.id !== p.item.id || !r.play) return;
        if (!nid) { queueRef.current = r.queue; setQueue(r.queue); } // autoplay appended songs at the end
        nextUp.current = { afterId: p.item.id, play: r.play };
      })
      .catch(() => { peekAgainAt.current = Date.now() + 5000; }) // `ended` falls back to the normal (waiting) way
      .finally(() => { if (peeking.current === p.item.id) peeking.current = null; });
  }, [after, caps]);

  /**
   * Switch to the prepared next song synchronously, inside the `ended` event. A backgrounded phone keeps a page alive only
   * while it plays audio: waiting for the server between two songs let Android freeze the app, so the next song never started.
   * The server is told afterwards (it makes the song current and preloads the one after).
   */
  const handoff = useCallback((n: PlayInfo) => {
    const q = queueRef.current;
    if (q) { const nq = { ...q, state: { ...q.state, currentItemId: n.item.id, positionSec: 0 } }; queueRef.current = nq; setQueue(nq); }
    reported.current = null;
    retried.current = null;
    playRef.current = n;
    setPlay(n);
    setCapture(n.status ?? null);
    setError((e) => (e.startsWith("Skipped ") ? e : ""));
    attach(n, 0);
    api<{ play: PlayInfo | null; queue: Queue }>("/api/music/play", { method: "POST", body: { itemId: n.item.id, caps: caps() } })
      .then((r) => {
        if (playRef.current?.item.id !== n.item.id) return;
        setQueue(r.queue);
        if (!r.play) return;
        setPlay(r.play);
        if (r.play.url !== n.url) { setCapture(r.play.status ?? null); attach(r.play, offset.current + (audio.current?.currentTime ?? 0)); } // other audio after all
      })
      .catch(() => {}); // the audio already plays; the next status poll / error handler covers a dropped entry
  }, [attach, caps]);

  // ----- audio element events -----
  const onTime = () => {
    const a = audio.current;
    if (!a) return;
    const t = offset.current + a.currentTime;
    setPosition(t);
    if (a.duration && Number.isFinite(a.duration) && playRef.current?.kind === "local" && !playRef.current.transcode) setDuration(a.duration);
    const total = (a.duration && Number.isFinite(a.duration) ? a.duration : 0) || playRef.current?.durationSec || 0;
    if (!a.paused && t > 3 && (total ? total - t <= 30 : t >= 20)) peek();
  };
  const onLoadedMeta = () => {
    const a = audio.current;
    if (a && pendingSeek.current !== null && Number.isFinite(a.duration || Infinity)) { try { a.currentTime = pendingSeek.current; } catch { /* not seekable yet */ } pendingSeek.current = null; }
  };
  const onEnded = () => {
    report(true);
    skips.current = 0;
    const p = playRef.current;
    const nid = p ? after(p.item.id, true) : null;
    if (p && nid === p.item.id) { reported.current = null; attach(p, 0); return; } // repeat one: same audio from the start
    const pre = nextUp.current;
    nextUp.current = null;
    if (p && pre && pre.afterId === p.item.id && pre.play.item.id === nid) { handoff(pre.play); return; }
    goNext(true);
  };
  const onError = () => {
    const p = playRef.current;
    if (!p) return;
    // A library file the browser can't decode (MEDIA_ERR_SRC_NOT_SUPPORTED): have the server convert it.
    if (p.kind === "local" && !p.transcode && audio.current?.error?.code === 4 && retried.current !== `${p.item.id}:t`) {
      retried.current = `${p.item.id}:t`;
      void start({ itemId: p.item.id, forceTranscode: true }, offset.current + (audio.current?.currentTime ?? 0));
      return;
    }
    // One automatic retry (re-prepares on-demand audio that was cleaned up or whose capture dropped), then skip on.
    if (retried.current !== p.item.id) {
      retried.current = p.item.id;
      void start({ itemId: p.item.id }, offset.current + (audio.current?.currentTime ?? 0));
      return;
    }
    // Out of retries: ask the worker why (source refused, no match, ffmpeg missing, ...) so the message says more than "couldn't play".
    void (async () => {
      let why = "the audio could not be played";
      if (p.key) {
        try {
          const s = await api<EntryStatus>(`/api/music/od/${p.key}/status`);
          if (s.error) why = s.error;
          else if (s.state === "ready" && audio.current?.error?.code === 4) why = "your browser can't decode this format";
        } catch { /* worker restarted / entry cleaned up */ }
      }
      if (playRef.current?.item.id !== p.item.id) return; // the user moved on meanwhile
      if (!skipFrom(p.item.id, p.item.title, why)) { setError(`Couldn't play “${p.item.title}”: ${why}.`); setPlaying(false); }
    })();
  };

  // ----- on-demand capture status + heartbeat -----
  useEffect(() => {
    if (!play?.key || capture?.state === "ready") return;
    const key = play.key;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<EntryStatus>(`/api/music/od/${key}/status`);
        if (stop) return;
        setCapture(s);
        // The server moved this song to another recording (the first source stopped mid-way): say so instead of switching silently.
        const sid = s.candidate?.sourceId;
        if (sid) {
          const seen = lastSource.current;
          if (seen?.key === key && seen.id !== sid && playRef.current?.key === key) flash(`“${playRef.current.item.title}”: the first source stopped, switched to another recording (${s.candidate?.sourceName ?? s.candidate?.engine}).`);
          lastSource.current = { key, id: sid };
        }
        if (s.durationSec) setDuration((d) => d || s.durationSec!);
        if (s.state === "ready" && pendingSeek.current !== null) { // a seek waited for the complete file
          const at = pendingSeek.current;
          pendingSeek.current = null;
          const a = audio.current;
          if (a && playRef.current?.key === key) { const was = !a.paused; a.src = playRef.current.url; pendingSeek.current = at; if (was) void a.play(); }
        }
      } catch { /* worker restarted / cleaned up: the audio error handler re-prepares */ }
    };
    const t = setInterval(tick, 1000);
    void tick();
    return () => { stop = true; clearInterval(t); };
  }, [play?.key, capture?.state, flash]);

  useEffect(() => {
    if (!mode?.onDemand || !play) return;
    const t = setInterval(() => { api("/api/music/ping", { method: "POST" }).catch(() => {}); }, 20_000);
    return () => clearInterval(t);
  }, [mode?.onDemand, play]);

  useEffect(() => { sendPresence(); }, [play?.item.id, playing, sendPresence]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(sendPresence, 30_000);
    return () => clearInterval(t);
  }, [playing, sendPresence]);
  useEffect(() => {
    const on = () => { presenceOff.current = 0; sendPresence(); };
    window.addEventListener("rift:presence-changed", on);
    return () => window.removeEventListener("rift:presence-changed", on);
  }, [sendPresence]);

  // remember the position (cheap) so the queue resumes where it stopped
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => { const a = audio.current; if (a) api("/api/music/queue/state", { method: "PATCH", body: { positionSec: offset.current + a.currentTime } }).catch(() => {}); }, 15_000);
    return () => clearInterval(t);
  }, [playing]);

  // ----- controls -----
  const toggle = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    if (!playRef.current) { // nothing loaded yet: resume the saved queue
      const q = queueRef.current;
      if (q?.state.currentItemId) void start({ itemId: q.state.currentItemId }, q.state.positionSec);
      else if (q?.items.length) void start({ itemId: q.items[0].id });
      return;
    }
    if (a.paused) void a.play().then(() => setPlaying(true)).catch(() => {}); else { a.pause(); setPlaying(false); }
  }, [start]);

  const seek = useCallback((t: number) => {
    const a = audio.current;
    const p = playRef.current;
    if (!a || !p) return;
    const target = Math.max(0, t);
    setPosition(target);
    if (p.transcode) { attach(p, target); return; } // restart the converted stream at the offset
    if (p.kind === "ondemand" && capture?.state !== "ready") {
      // Still being captured: seek inside what we have, otherwise wait for the complete file.
      const buffered = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0;
      if (target <= buffered - 0.5) { a.currentTime = target; return; }
      pendingSeek.current = target;
      return;
    }
    if (p.kind === "ondemand" && a.duration === Infinity) { a.src = p.url; pendingSeek.current = target; void a.play(); return; }
    a.currentTime = target;
  }, [attach, capture?.state]);

  const patch = useCallback(async (b: Record<string, unknown>) => { try { setQueue(await api<Queue>("/api/music/queue/state", { method: "PATCH", body: b })); } catch (e) { setError((e as Error).message); } }, []);

  const value: PlayerCtx = {
    queue, current, play, playing, loading, position, duration, capture, error, volume, muted, mode,
    async playItems(items, o) {
      setLoading(true); setError(""); skips.current = 0;
      try {
        report(false);
        const q = await api<Queue>("/api/music/queue", { method: "PUT", body: { items, ...o } });
        setQueue(q);
        await start({ itemId: q.state.currentItemId ?? q.items[0].id });
      } catch (e) { setError((e as Error).message); setLoading(false); }
    },
    async playQueueItem(id) { skips.current = 0; report(false); await start({ itemId: id }); },
    async addToQueue(items, where = "end") {
      try { setQueue(await api<Queue>("/api/music/queue/add", { method: "POST", body: { items, where } })); } catch (e) { setError((e as Error).message); }
    },
    async playRadio(trackId) {
      skips.current = 0; setError("");
      try { report(false); const q = await api<Queue>("/api/music/radio", { method: "POST", body: { trackId } }); setQueue(q); await start({ itemId: q.state.currentItemId ?? q.items[0].id }); } catch (e) { setError((e as Error).message); }
    },
    async playPlaylist(id, o) {
      skips.current = 0; setError("");
      try { report(false); const q = await api<Queue>(`/api/music/playlists/${id}/play`, { method: "POST", body: o ?? {} }); setQueue(q); await start({ itemId: q.state.currentItemId ?? q.items[0].id }); } catch (e) { setError((e as Error).message); }
    },
    toggle,
    next() { skips.current = 0; netTries.current = 0; report(false); goNext(false); },
    prev() {
      const a = audio.current;
      if (a && offset.current + a.currentTime > 4) { seek(0); return; } // like most players: restart first
      skips.current = 0; report(false); void start({ dir: "prev" });
    },
    seek,
    setShuffle: (v) => void patch({ shuffle: v }),
    setRepeat: (v) => void patch({ repeat: v }),
    setAutoplay: (v) => void patch({ autoplay: v }),
    setVolume(v) { setVolumeState(v); try { localStorage.setItem("rift.music.volume", String(v)); } catch { /* ignore */ } },
    setMuted(v) { setMutedState(v); try { localStorage.setItem("rift.music.muted", v ? "1" : "0"); } catch { /* ignore */ } },
    async removeFromQueue(id) {
      try {
        const wasCurrent = queueRef.current?.state.currentItemId === id;
        const q = await api<Queue>("/api/music/queue/remove", { method: "POST", body: { id } });
        setQueue(q);
        if (wasCurrent) { if (q.state.currentItemId) await start({ itemId: q.state.currentItemId }); else { audio.current?.pause(); setPlay(null); setPlaying(false); } }
      } catch (e) { setError((e as Error).message); }
    },
    async moveInQueue(id, toIndex) { try { setQueue(await api<Queue>("/api/music/queue/move", { method: "POST", body: { id, toIndex } })); } catch (e) { setError((e as Error).message); } },
    async clearQueue() { try { setQueue(await api<Queue>("/api/music/queue/clear", { method: "POST" })); audio.current?.pause(); setPlay(null); setPlaying(false); setCapture(null); } catch (e) { setError((e as Error).message); } },
  };

  // ----- media keys / lock screen / Android + iOS "now playing" card -----
  const latest = useRef(value);
  latest.current = value;
  const art = current ? artSrc(current.artworkUrl) : null;
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) { ms.metadata = null; return; }
    // The card needs absolute URLs, and several sizes make Android pick the sharp one. Without a cover the Rift icon is shown.
    const src = new URL(art ?? "/icons/icon-512.png", location.origin).href;
    ms.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album ?? "", artwork: [96, 128, 192, 256, 384, 512].map((n) => ({ src, sizes: `${n}x${n}` })) });
  }, [current, art]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, f: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
    set("play", () => { const a = audio.current; if (a?.paused) latest.current.toggle(); });
    set("pause", () => { const a = audio.current; if (a && !a.paused) latest.current.toggle(); });
    set("nexttrack", () => latest.current.next());
    set("previoustrack", () => latest.current.prev());
    set("seekto", (d) => { if (d.seekTime !== undefined) latest.current.seek(d.seekTime); });
    set("seekforward", (d) => latest.current.seek(latest.current.position + (d.seekOffset ?? 10)));
    set("seekbackward", (d) => latest.current.seek(latest.current.position - (d.seekOffset ?? 10)));
    set("stop", () => { const a = audio.current; if (a && !a.paused) latest.current.toggle(); });
  }, []);
  useEffect(() => { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = !current ? "none" : playing ? "playing" : "paused"; }, [playing, current]);
  // progress bar on the card (position/duration are cheap to set; once per track and on seeks/pauses is enough)
  const sec = Math.floor(position);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current || !duration || !Number.isFinite(duration)) return;
    try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(0, sec), duration) }); } catch { /* not supported / invalid */ }
  }, [current, duration, playing, sec - (sec % 5)]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={value}>
      <audio
        ref={audio}
        preload="auto"
        onTimeUpdate={onTime}
        onLoadedMetadata={onLoadedMeta}
        onPlay={() => setPlaying(true)}
        onPlaying={() => { skips.current = 0; }}
        onPause={() => setPlaying(false)}
        onSeeked={sendPresence}
        onEnded={onEnded}
        onError={onError}
        data-testid="music-audio"
      />
      {children}
    </Ctx.Provider>
  );
}
