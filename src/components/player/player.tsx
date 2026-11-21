"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle, ArrowLeft, AudioLines, Check, Gauge, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Search, SkipForward, Subtitles, Settings, Volume1, Volume2, VolumeX,
} from "lucide-react";
import type { PlayerInfo } from "@/lib/types";
import { decide, pickAudioEncoder, type PlayMode } from "@/lib/compat";
import { SubtitleFinder } from "../subtitle-finder";
import { type Engine, MediabunnyEngine, startDirect, startHls } from "./engines";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const langName = (l?: string) => { try { return l ? new Intl.DisplayNames(["en"], { type: "language" }).of(l) ?? l : undefined; } catch { return l; } };
const codecLabel = (c: string) => ({ eac3: "Dolby Digital+", ac3: "Dolby Digital", aac: "AAC", opus: "Opus", dts: "DTS", truehd: "TrueHD", flac: "FLAC", mp3: "MP3" }[c] ?? c.toUpperCase());

type Menu = null | "subs" | "audio" | "quality" | "speed";

export function Player({ fileId, torrent = false }: { fileId: string; torrent?: boolean }) {
  // Torrent streams: served by /api/ondemand/:id, kept alive by a heartbeat, no server transcode.
  const urls = torrent
    ? { info: `/api/ondemand/${fileId}/info`, file: `/api/ondemand/${fileId}/file`, beat: `/api/ondemand/${fileId}` }
    : { info: `/api/media/${fileId}/info`, file: `/api/stream/${fileId}`, beat: "" };
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const streamId = useRef(crypto.randomUUID().replace(/-/g, "").slice(0, 24));
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSave = useRef(0);

  const [info, setInfo] = useState<PlayerInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [mode, setMode] = useState<PlayMode>("direct");
  const [detail, setDetail] = useState("");
  const [audioOrdinal, setAudioOrdinal] = useState(0);
  const [forceHls, setForceHls] = useState(false);
  const [heights, setHeights] = useState<number[]>([]);
  const [quality, setQuality] = useState<number | "auto">("auto");
  const [subIndex, setSubIndex] = useState(-1);
  const [speed, setSpeed] = useState(1);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [full, setFull] = useState(false);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [hoverT, setHoverT] = useState<{ x: number; t: number } | null>(null);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const [finder, setFinder] = useState(false);

  const duration = info?.durationSec ?? 0;

  /* ---- load info ---- */
  useEffect(() => {
    let live = true;
    fetch(urls.info)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load media"); return r.json() as Promise<PlayerInfo>; })
      .then((i) => {
        if (!live) return;
        setInfo(i);
        const def = i.audio.findIndex((a) => a.default);
        setAudioOrdinal(def >= 0 ? def : 0);
        const d = i.subtitles.findIndex((s) => s.isDefault);
        setSubIndex(d);
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [fileId]);

  /* ---- (re)start engine whenever source options change ---- */
  const startAtRef = useRef<number | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!info || !video) return;
    let cancelled = false;
    const resumeAt = startAtRef.current ?? info.resumeSec;
    startAtRef.current = null;
    setBusy(true);
    setError("");

    (async () => {
      const d = decide(info, audioOrdinal, forceHls && !torrent ? "hls" : undefined);
      setMode(d.mode);
      setDetail(d.reason);
      if (torrent && d.mode === "hls") {
        setError(`${d.reason}. On-demand streams can't be transcoded on the server — add this torrent to the library instead.`);
        setBusy(false);
        return;
      }
      let engine: Engine;
      try {
        if (d.mode === "direct") {
          engine = await startDirect(video, urls.file, resumeAt);
        } else if (d.mode === "mediabunny") {
          const track = info.audio[audioOrdinal] ?? info.audio[0];
          const audioCodec = await pickAudioEncoder(false); // AAC wherever the browser can encode it; Opus only as a fallback
          const e = new MediabunnyEngine(video, {
            url: urls.file, durationSec: info.durationSec, audioOrdinal, audioCodec, sourceAudioCodec: track?.codec,
            onBusy: (b) => !cancelled && setBusy(b), onError: (m) => !cancelled && setError(m),
          });
          engine = e;
          engineRef.current = e;
          await e.init(resumeAt);
        } else {
          const res = await fetch(`/api/media/${fileId}/hls`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ audioIndex: info.audio[audioOrdinal]?.index, startPosition: resumeAt || undefined }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? "Could not start transcoding");
          engine = await startHls(video, body.masterUrl, resumeAt, (m) => !cancelled && setError(m));
        }
      } catch (e) {
        if (!cancelled) {
          const msg = (e as Error).message;
          // Browser can't do the in-browser path: fall back to a server transcode once.
          if (!torrent && !forceHls && d.mode === "mediabunny") { setForceHls(true); startAtRef.current = resumeAt; return; }
          setError(msg);
          setBusy(false);
        }
        return;
      }
      if (cancelled) { engine.destroy(); return; }
      engineRef.current = engine;
      setDetail(engine.mode === "mediabunny" ? engine.detail : d.mode === "hls" ? `${engine.detail} — ${d.reason}` : d.reason);
      if (engine.mode !== "mediabunny") setBusy(false);
      video.playbackRate = speed;
      video.play().catch(() => setPlaying(false));
      if (engine.mode === "hls") {
        const iv = setInterval(() => { if (engine.heights?.length) { setHeights(engine.heights); clearInterval(iv); } }, 500);
        setTimeout(() => clearInterval(iv), 15000);
      } else setHeights([]);
    })();

    return () => {
      cancelled = true;
      const e = engineRef.current;
      engineRef.current = null;
      if (e) {
        // keep position when the user switches audio/quality
        startAtRef.current = video.currentTime || null;
        void e.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, audioOrdinal, forceHls, fileId]);

  /* ---- video element events ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const on = {
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      timeupdate: () => {
        setTime(v.currentTime);
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - 0.1 && v.currentTime <= b.end(i) + 0.1) setBuffered(b.end(i));
      },
      waiting: () => setBusy(true),
      playing: () => setBusy(false),
      canplay: () => setBusy(false),
      volumechange: () => { setVolume(v.volume); setMuted(v.muted); },
      ended: () => { if (info?.next) setNextIn(0); },
    };
    Object.entries(on).forEach(([k, f]) => v.addEventListener(k, f));
    return () => Object.entries(on).forEach(([k, f]) => v.removeEventListener(k, f));
  }, [info]);

  /* ---- subtitles ---- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => Array.from(v.textTracks).forEach((t, i) => { t.mode = i === subIndex ? "showing" : "disabled"; });
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    return () => v.textTracks.removeEventListener("addtrack", apply);
  }, [subIndex, info]);

  /* ---- progress heartbeat + stream registration ---- */
  const save = useCallback((force = false) => {
    const v = videoRef.current;
    if (torrent || !v || !info || (!force && Date.now() - lastSave.current < 9000)) return;
    lastSave.current = Date.now();
    fetch("/api/progress", {
      method: "POST", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ mediaFileId: fileId, position: v.currentTime, duration: info.durationSec || v.duration || 0, streamId: streamId.current, mode, detail }),
    }).catch(() => {});
  }, [fileId, info, mode, detail, torrent]);
  useEffect(() => { if (playing) save(); }, [time, playing, save]);
  // Torrent streams: heartbeat every 15 s (even while paused) so the server keeps the data; ~1 min of silence deletes it.
  useEffect(() => {
    if (!torrent) return;
    const beat = () => fetch(urls.beat, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "heartbeat" }) }).catch(() => {});
    beat();
    const t = setInterval(beat, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrent, fileId]);
  useEffect(() => {
    if (torrent) return;
    const sid = streamId.current;
    const bye = () => { save(true); fetch(`/api/progress?streamId=${sid}`, { method: "DELETE", keepalive: true }).catch(() => {}); };
    window.addEventListener("pagehide", bye);
    return () => { window.removeEventListener("pagehide", bye); bye(); };
  }, [save]);

  /* ---- next episode countdown ---- */
  const nearEnd = !!info?.next && duration > 0 && time > duration - 25;
  useEffect(() => {
    if (nextIn === null || !info?.next) return;
    if (nextIn <= 0) { save(true); router.replace(`/watch/${info.next.fileId}`); return; }
    const t = setTimeout(() => setNextIn(nextIn - 1), 1000);
    return () => clearTimeout(t);
  }, [nextIn, info, router, save]);
  useEffect(() => { if (nextIn === 0 && info?.next) router.replace(`/watch/${info.next.fileId}`); }, [nextIn, info, router]);

  /* ---- controls ---- */
  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!videoRef.current?.paused) { setControls(false); setMenu(null); } }, document.documentElement.classList.contains("tv") ? 7000 : 3200);
  }, []);
  const toggle = () => { const v = videoRef.current; if (!v) return; v.paused ? v.play().catch(() => {}) : v.pause(); };
  const seekBy = (d: number) => { const v = videoRef.current; if (v) v.currentTime = Math.min(Math.max(0, v.currentTime + d), duration || v.duration || 1e9); poke(); };
  const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen(); else wrapRef.current?.requestFullscreen?.().catch(() => {}); };
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  useEffect(() => {
    // Capture phase: runs before the global spatial navigation, which only gets the arrows we leave alone.
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog (subtitle finder) owns the keyboard
      const v = videoRef.current;
      if (!v) return;
      const inUi = !!t?.closest("[data-player-ui]"); // a control (button / seek bar) has focus: remote / keyboard "menu mode"
      const onSeek = t?.getAttribute("aria-label") === "Seek";
      switch (e.key) {
        case " ": case "k": if (inUi && t?.tagName === "BUTTON") return; e.preventDefault(); toggle(); break;
        case "Enter": if (inUi) { poke(); return; } e.preventDefault(); toggle(); break; // remote OK = play/pause
        case "j": seekBy(-10); break;
        case "l": seekBy(10); break;
        case "ArrowLeft": if (inUi && !onSeek) { poke(); return; } e.preventDefault(); seekBy(-10); break;
        case "ArrowRight": if (inUi && !onSeek) { poke(); return; } e.preventDefault(); seekBy(10); break;
        case "ArrowUp": case "ArrowDown":
          // Up/Down reveal the controls and move focus into them (TV remote); once inside, the spatial navigation takes over.
          // Volume: M, the volume slider, or the TV itself.
          poke();
          if (inUi && onSeek && e.key === "ArrowDown") {
            // The seek bar spans the full width, so geometry can't pick a button: go to Play/Pause first.
            e.preventDefault();
            wrapRef.current?.querySelector<HTMLElement>('[data-player-ui] button[aria-label="Play"], [data-player-ui] button[aria-label="Pause"]')?.focus();
            return;
          }
          if (inUi) return;
          e.preventDefault();
          setTimeout(() => wrapRef.current?.querySelector<HTMLElement>('[data-player-ui] input[aria-label="Seek"]')?.focus(), 60);
          return;
        case "m": v.muted = !v.muted; break;
        case "f": toggleFull(); break;
        case "c": setSubIndex((s) => (s >= 0 ? -1 : info?.subtitles.length ? 0 : -1)); break;
        case "BrowserBack": case "GoBack": case "XF86Back": e.preventDefault(); back(); return;
        default: if (e.keyCode === 10009 || e.keyCode === 461) { e.preventDefault(); back(); } return;
      }
      poke();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, duration]);

  const pickQuality = (q: number | "auto") => {
    setQuality(q);
    setMenu(null);
    if (mode === "hls") engineRef.current?.setQuality?.(q);
    else if (q !== "auto") { startAtRef.current = videoRef.current?.currentTime ?? null; setForceHls(true); }
  };

  const back = () => { save(true); router.push(info?.backPath ?? "/"); };

  const pct = duration ? (time / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  const showUi = controls || !playing || !!menu;

  return (
    <div ref={wrapRef} onMouseMove={poke} onClick={() => setMenu(null)} className={clsx("fixed inset-0 select-none overflow-hidden bg-black", !showUi && "cursor-none")}>
      <video ref={videoRef} className="size-full bg-black object-contain" playsInline crossOrigin="use-credentials" onClick={(e) => { e.stopPropagation(); toggle(); }} onDoubleClick={toggleFull}>
        {info?.subtitles.map((s) => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.language?.slice(0, 2) ?? "und"} src={`/api/subtitles/${s.id}`} />
        ))}
      </video>

      {busy && !error && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><Loader2 className="size-14 animate-spin text-white/90 drop-shadow" /></div>}

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <AlertTriangle className="size-12 text-amber-400" />
          <p className="max-w-lg text-lg">{error}</p>
          <div className="flex gap-3">
            {mode !== "hls" && !torrent && <button onClick={() => { setError(""); startAtRef.current = videoRef.current?.currentTime ?? null; setForceHls(true); }} className="btn-primary rounded-lg px-5 py-2.5 font-semibold">Try server transcode</button>}
            <button onClick={back} className="rounded-lg border border-white/20 px-5 py-2.5 font-semibold hover:bg-white/10">Go back</button>
          </div>
        </div>
      )}
      {!info && !error && <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-14 animate-spin text-white/80" /></div>}

      <AnimatePresence>
        {showUi && info && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="pointer-events-none absolute inset-0">
            <div data-player-ui data-fixed className="pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/85 to-transparent px-5 pb-10 pt-5" onClick={(e) => e.stopPropagation()}>
              <button onClick={back} aria-label="Back" className="rounded-full p-2 transition hover:bg-white/15"><ArrowLeft className="size-7" /></button>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{info.title}</p>
                {info.subtitle && <p className="truncate text-sm text-white/70">{info.subtitle}</p>}
              </div>
              <span title={detail} className="ml-auto hidden max-w-md truncate rounded-md bg-white/10 px-2.5 py-1 text-xs text-white/80 sm:block">{mode === "direct" ? "Direct play" : mode === "mediabunny" ? "Mediabunny" : "Transcoding"} · {detail}</span>
            </div>

            {!playing && !busy && !error && (
              <button onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label="Play" className="pointer-events-auto absolute left-1/2 top-1/2 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 backdrop-blur transition hover:scale-110">
                <Play className="size-10 fill-white" />
              </button>
            )}

            {nearEnd && info.next && nextIn === null && (
              <button onClick={(e) => { e.stopPropagation(); setNextIn(0); }} className="pointer-events-auto absolute bottom-28 right-6 flex items-center gap-2 rounded-lg border border-white/30 bg-black/70 px-5 py-3 font-semibold backdrop-blur hover:bg-white hover:text-black">
                <SkipForward className="size-5" /> Next: {info.next.label}
              </button>
            )}

            <div data-player-ui data-fixed className="pointer-events-auto absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-5 pb-4 pt-16" onClick={(e) => e.stopPropagation()}>
              <div
                className="group relative mb-2 h-5 cursor-pointer"
                onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverT({ x: e.clientX - r.left, t: ((e.clientX - r.left) / r.width) * duration }); }}
                onMouseLeave={() => setHoverT(null)}
              >
                <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 transition-all group-hover:h-1.5 group-focus-within:h-2">
                  <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${bufPct}%` }} />
                  <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent to-accent-dark" style={{ width: `${pct}%` }} />
                </div>
                <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow transition group-hover:scale-100 group-focus-within:scale-125" style={{ left: `${pct}%` }} />
                <input
                  type="range" min={0} max={duration || 1} step={0.1} value={time} aria-label="Seek"
                  onChange={(e) => { const v = videoRef.current; if (v) { v.currentTime = Number(e.target.value); setTime(Number(e.target.value)); } }}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
                {hoverT && <span className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/85 px-2 py-0.5 text-xs" style={{ left: hoverT.x }}>{fmt(hoverT.t)}</span>}
              </div>

              <div className="flex items-center gap-1.5 sm:gap-3">
                <IconBtn label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? <Pause className="size-7 fill-white" /> : <Play className="size-7 fill-white" />}</IconBtn>
                <IconBtn label="Back 10 seconds" onClick={() => seekBy(-10)}><RotateCcw className="size-6" /></IconBtn>
                <IconBtn label="Forward 10 seconds" onClick={() => seekBy(10)}><RotateCw className="size-6" /></IconBtn>
                <div className="group/vol flex items-center">
                  <IconBtn label={muted ? "Unmute" : "Mute"} onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}>
                    {muted || volume === 0 ? <VolumeX className="size-6" /> : volume < 0.5 ? <Volume1 className="size-6" /> : <Volume2 className="size-6" />}
                  </IconBtn>
                  <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => { const v = videoRef.current; if (v) { v.muted = false; v.volume = Number(e.target.value); } }} className="rift-range hidden w-0 transition-all group-hover/vol:w-24 sm:block" style={{ ["--track" as string]: "#ffffff55" }} />
                </div>
                <span className="ml-1 text-sm tabular-nums text-white/90">{fmt(time)} <span className="text-white/50">/ {fmt(duration)}</span></span>

                <div className="ml-auto flex items-center gap-1 sm:gap-2">
                  {info.next && <IconBtn label="Next episode" onClick={() => setNextIn(0)}><SkipForward className="size-6" /></IconBtn>}
                  <MenuBtn icon={<Subtitles className="size-6" />} label="Subtitles" open={menu === "subs"} onToggle={() => setMenu(menu === "subs" ? null : "subs")} active={subIndex >= 0}>
                    <MenuItem checked={subIndex < 0} onClick={() => { setSubIndex(-1); setMenu(null); }}>Off</MenuItem>
                    {info.subtitles.map((s, i) => <MenuItem key={s.id} checked={subIndex === i} onClick={() => { setSubIndex(i); setMenu(null); }}>{s.label}</MenuItem>)}
                    {!info.subtitles.length && <p className="px-4 py-2 text-xs text-white/50">No subtitles available</p>}
                    {info.canFindSubtitles && !torrent && (
                      <button onClick={() => { videoRef.current?.pause(); setMenu(null); setFinder(true); }} className="flex w-full items-center gap-2 whitespace-nowrap border-t border-white/10 px-4 py-2 text-left text-violet-300 hover:bg-white/10"><Search className="size-4" /> Find online…</button>
                    )}
                  </MenuBtn>
                  <MenuBtn icon={<AudioLines className="size-6" />} label="Audio" open={menu === "audio"} onToggle={() => setMenu(menu === "audio" ? null : "audio")}>
                    {info.audio.map((a, i) => (
                      <MenuItem key={a.index} checked={audioOrdinal === i} onClick={() => { startAtRef.current = videoRef.current?.currentTime ?? null; setAudioOrdinal(i); setMenu(null); }}>
                        {langName(a.language) ?? a.title ?? `Track ${i + 1}`} <span className="text-white/50">· {codecLabel(a.codec)}{a.channels ? ` ${a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : a.channels === 2 ? "2.0" : a.channels + "ch"}` : ""}</span>
                      </MenuItem>
                    ))}
                  </MenuBtn>
                  {!torrent && <MenuBtn icon={<Settings className="size-6" />} label="Quality" open={menu === "quality"} onToggle={() => setMenu(menu === "quality" ? null : "quality")}>
                    {mode !== "hls" && <MenuItem checked={quality === "auto"} onClick={() => pickQuality("auto")}>Original{info.video ? ` (${info.video.height}p)` : ""}</MenuItem>}
                    {mode === "hls" && <MenuItem checked={quality === "auto"} onClick={() => pickQuality("auto")}>Auto</MenuItem>}
                    {(mode === "hls" && heights.length ? heights : info.ladder.filter((h) => !info.video || h <= info.video.height)).map((h) => (
                      <MenuItem key={h} checked={quality === h} onClick={() => pickQuality(h)}>{h}p{mode !== "hls" && <span className="text-white/50"> · server transcode</span>}</MenuItem>
                    ))}
                  </MenuBtn>}
                  <MenuBtn icon={<Gauge className="size-6" />} label="Playback speed" open={menu === "speed"} onToggle={() => setMenu(menu === "speed" ? null : "speed")}>
                    {SPEEDS.map((s) => <MenuItem key={s} checked={speed === s} onClick={() => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; setMenu(null); }}>{s === 1 ? "Normal" : `${s}×`}</MenuItem>)}
                  </MenuBtn>
                  <IconBtn label="Fullscreen" onClick={toggleFull}>{full ? <Minimize className="size-6" /> : <Maximize className="size-6" />}</IconBtn>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {info?.canFindSubtitles && (
        <SubtitleFinder
          fileId={fileId} title={info.title} open={finder} onClose={() => setFinder(false)}
          onAdded={(sub) => { const n = info.subtitles.length; setInfo((i) => (i ? { ...i, subtitles: [...i.subtitles, { id: sub.id, label: sub.label, language: sub.language ?? undefined, isDefault: false }] } : i)); setSubIndex(n); }}
        />
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button aria-label={label} title={label} onClick={onClick} className="rounded-full p-2 text-white transition hover:scale-110 hover:bg-white/15">{children}</button>;
}

function MenuBtn({ icon, label, open, onToggle, active, children }: { icon: React.ReactNode; label: string; open: boolean; onToggle: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative">
      <button aria-label={label} title={label} aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }} className={clsx("rounded-full p-2 transition hover:scale-110 hover:bg-white/15", active && "text-accent")}>{icon}</button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.12 }} onClick={(e) => e.stopPropagation()} className="glass absolute bottom-full right-0 mb-3 max-h-72 min-w-48 overflow-y-auto rounded-xl border border-white/10 py-1.5 text-sm shadow-2xl">
            <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/45">{label}</p>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 whitespace-nowrap px-4 py-2 text-left hover:bg-white/10">
      <span className="w-4">{checked && <Check className="size-4 text-accent" />}</span>
      <span>{children}</span>
    </button>
  );
}
