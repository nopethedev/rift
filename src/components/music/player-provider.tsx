"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../ui";
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
const MAX_SKIPS = 3;

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

  const start = useCallback(async (body: { itemId?: string; dir?: "next" | "prev"; auto?: boolean; forceTranscode?: boolean }, at = 0) => {
    setLoading(true);
    setError("");
    try {
      const r = await api<{ play: PlayInfo | null; queue: Queue; ended: boolean }>("/api/music/play", { method: "POST", body: { ...body, caps: caps() } });
      setQueue(r.queue);
      if (r.ended || !r.play) { setPlay(null); setPlaying(false); setCapture(null); audio.current?.pause(); return; }
      reported.current = null;
      if (!retried.current?.startsWith(r.play.item.id)) retried.current = null; // new item: allow its own retry
      setPlay(r.play);
      setCapture(r.play.status ?? null);
      attach(r.play, at);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      setPlaying(false);
      // An unplayable item (not found, source refused, limit reached...) is skipped, a few times in a row at most.
      if (body.dir === "next" && skips.current < MAX_SKIPS && !/limit|try again/i.test(msg)) { skips.current++; setTimeout(() => void start({ dir: "next" }), 1200); }
    } finally {
      setLoading(false);
    }
  }, [attach, caps]);

  // ----- audio element events -----
  const onTime = () => {
    const a = audio.current;
    if (!a) return;
    setPosition(offset.current + a.currentTime);
    if (a.duration && Number.isFinite(a.duration) && playRef.current?.kind === "local" && !playRef.current.transcode) setDuration(a.duration);
  };
  const onLoadedMeta = () => {
    const a = audio.current;
    if (a && pendingSeek.current !== null && Number.isFinite(a.duration || Infinity)) { try { a.currentTime = pendingSeek.current; } catch { /* not seekable yet */ } pendingSeek.current = null; }
  };
  const onEnded = () => {
    report(true);
    skips.current = 0;
    void start({ dir: "next", auto: true });
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
    setError(`Couldn't play “${p.item.title}”. Skipping.`);
    if (skips.current < MAX_SKIPS) { skips.current++; setTimeout(() => void start({ dir: "next", auto: true }), 1200); } else setPlaying(false);
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
  }, [play?.key, capture?.state]);

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
    next() { skips.current = 0; report(false); void start({ dir: "next" }); },
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
