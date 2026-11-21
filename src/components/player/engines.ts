// Playback engines. Each one owns the <video> element's source until destroy() is called.
import type { Conversion, Input } from "mediabunny";

export interface Engine {
  mode: "direct" | "mediabunny" | "hls";
  /** Human readable description shown in the stats badge. */
  detail: string;
  destroy(): void | Promise<void>;
  /** Quality ladder (HLS only). */
  heights?: number[];
  setQuality?(height: number | "auto"): void;
}

/* ------------------------------------------------------------------ direct */

export async function startDirect(video: HTMLVideoElement, url: string, startAt: number): Promise<Engine> {
  video.src = url;
  if (startAt > 0) video.addEventListener("loadedmetadata", () => { video.currentTime = startAt; }, { once: true });
  return {
    mode: "direct",
    detail: "Direct play",
    destroy() {
      video.removeAttribute("src");
      video.load();
    },
  };
}

/* --------------------------------------------------------------------- hls */

export async function startHls(
  video: HTMLVideoElement,
  masterUrl: string,
  startAt: number,
  onFatal: (msg: string) => void,
): Promise<Engine> {
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    // Safari / iOS: native HLS
    video.src = masterUrl;
    if (startAt > 0) video.addEventListener("loadedmetadata", () => { video.currentTime = startAt; }, { once: true });
    return { mode: "hls", detail: "Server transcode (HLS)", destroy() { video.removeAttribute("src"); video.load(); } };
  }
  const hls = new Hls({ startPosition: startAt, maxBufferLength: 40, maxMaxBufferLength: 90, capLevelToPlayerSize: false, fragLoadingMaxRetry: 4, manifestLoadingMaxRetry: 3 });
  let retries = 0;
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries++ < 3) setTimeout(() => hls.startLoad(), 1000 * retries);
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retries++ < 3) hls.recoverMediaError();
    else onFatal(`Playback error: ${data.details}`);
  });
  hls.loadSource(masterUrl);
  hls.attachMedia(video);
  const engine: Engine = {
    mode: "hls",
    detail: "Server transcode (HLS)",
    heights: [],
    setQuality(h) {
      hls.currentLevel = h === "auto" ? -1 : hls.levels.findIndex((l) => l.height === h);
      if (h !== "auto") hls.nextLevel = hls.currentLevel;
    },
    destroy() {
      hls.destroy();
      video.removeAttribute("src");
      video.load();
    },
  };
  hls.on(Hls.Events.MANIFEST_PARSED, () => { engine.heights = hls.levels.map((l) => l.height).sort((a, b) => b - a); });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => { const l = hls.levels[d.level]; if (l) engine.detail = `Server transcode · ${l.height}p${hls.autoLevelEnabled ? " (auto)" : ""}`; });
  return engine;
}

/* --------------------------------------------------------------- mediabunny */

let ac3Registered = false;
async function ensureAc3() {
  if (ac3Registered) return;
  const { registerAc3Decoder } = await import("@mediabunny/ac3");
  registerAc3Decoder();
  ac3Registered = true;
}

export interface MediabunnyOptions {
  url: string;
  durationSec: number;
  audioOrdinal: number;
  audioCodec: "aac" | "opus";
  sourceAudioCodec?: string;
  onBusy: (busy: boolean) => void;
  onError: (msg: string) => void;
}

const AHEAD_SECONDS = 60; // how far the in-browser converter may run ahead of playback
const BEHIND_SECONDS = 30;

/**
 * Real-time in-browser pipeline:  file (HTTP range reads) --Mediabunny--> fragmented MP4 --MSE--> <video>.
 * Video packets are copied untouched; Dolby Digital / Digital Plus audio is decoded with the AC-3 WASM extension and
 * re-encoded to stereo AAC or Opus through WebCodecs. Seeking outside the buffered range restarts the pipeline at the target.
 */
export class MediabunnyEngine implements Engine {
  mode = "mediabunny" as const;
  detail: string;
  private ms = new MediaSource();
  private url = "";
  private sb: SourceBuffer | null = null;
  private sbMime = "";
  private gen = 0;
  private input: Input | null = null;
  private conversion: Conversion | null = null;
  private destroyed = false;
  private pipelineStart = 0;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private video: HTMLVideoElement, private o: MediabunnyOptions) {
    const src = (o.sourceAudioCodec ?? "audio").toUpperCase().replace("EAC3", "DD+").replace("AC3", "DD");
    this.detail = `In-browser: ${src} → ${o.audioCodec.toUpperCase()} (Mediabunny)`;
  }

  async init(startAt: number) {
    await ensureAc3();
    this.url = URL.createObjectURL(this.ms);
    this.video.src = this.url;
    await new Promise<void>((res) => this.ms.addEventListener("sourceopen", () => res(), { once: true }));
    if (this.o.durationSec > 0) this.ms.duration = this.o.durationSec;
    this.video.addEventListener("seeking", this.onSeeking);
    await this.restart(startAt);
    if (startAt > 0) this.video.currentTime = startAt;
  }

  private bufferedRanges(): [number, number][] {
    const out: [number, number][] = [];
    try {
      const b = this.sb?.buffered;
      if (b) for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    } catch { /* detached */ }
    return out;
  }
  private isBuffered(t: number) { return this.bufferedRanges().some(([s, e]) => t >= s - 0.05 && t <= e - 0.25); }
  private head() { return Math.max(this.pipelineStart, ...this.bufferedRanges().map(([, e]) => e)); }

  private onSeeking = () => {
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      const t = this.video.currentTime;
      if (this.destroyed || this.isBuffered(t)) return;
      // Slightly ahead of what's been produced: the running pipeline will get there; otherwise restart at the target.
      if (t >= this.pipelineStart && t <= this.head() + 6 && this.conversion?.state === "executing") return;
      this.restart(t).catch((e) => this.fail(e));
    }, 120);
  };

  private fail(e: unknown) {
    if (this.destroyed) return;
    console.error("[mediabunny]", e);
    this.o.onBusy(false);
    this.o.onError(e instanceof Error ? e.message : String(e));
  }

  private async stopPipeline() {
    const c = this.conversion, i = this.input;
    this.conversion = null;
    this.input = null;
    try { await c?.cancel(); } catch { /* ignore */ }
    try { i?.dispose(); } catch { /* ignore */ }
  }

  private waitIdle(sb: SourceBuffer) {
    return sb.updating ? new Promise<void>((r) => sb.addEventListener("updateend", () => r(), { once: true })) : Promise.resolve();
  }

  private async op(fn: (sb: SourceBuffer) => void): Promise<void> {
    const sb = this.sb!;
    await this.waitIdle(sb);
    await new Promise<void>((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const bad = () => { cleanup(); rej(new Error("SourceBuffer error")); };
      const cleanup = () => { sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad); };
      sb.addEventListener("updateend", ok);
      sb.addEventListener("error", bad);
      try { fn(sb); } catch (e) { cleanup(); rej(e); }
    });
  }

  private async append(data: Uint8Array, gen: number) {
    if (!this.sb || gen !== this.gen) return;
    try {
      await this.op((sb) => sb.appendBuffer(data as BufferSource));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        const keep = Math.max(0, this.video.currentTime - 5);
        await this.op((sb) => sb.remove(0, keep));
        await this.op((sb) => sb.appendBuffer(data as BufferSource));
      } else throw e;
    }
  }

  /** Backpressure: hold the converter while enough is buffered ahead of the playhead, and free old data. */
  private async pace(gen: number) {
    while (gen === this.gen && !this.destroyed) {
      const t = this.video.currentTime;
      const range = this.bufferedRanges().find(([s, e]) => t >= s - 0.1 && t <= e + 0.1);
      if (range && range[0] < t - BEHIND_SECONDS - 10 && this.sb && !this.sb.updating) {
        this.op((sb) => sb.remove(range[0], t - BEHIND_SECONDS)).catch(() => {});
      }
      const ahead = range ? range[1] - t : 0;
      if (ahead < AHEAD_SECONDS) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async restart(start: number) {
    const { Input, UrlSource, ALL_FORMATS, Output, Mp4OutputFormat, StreamTarget, Conversion } = await import("mediabunny");
    const gen = ++this.gen;
    this.o.onBusy(true);
    await this.stopPipeline();
    if (gen !== this.gen) return;
    this.pipelineStart = start;

    if (this.sb) {
      try { if (this.ms.readyState === "open") this.sb.abort(); } catch { /* ignore */ }
      await this.op((sb) => sb.remove(0, Infinity)).catch(() => {});
    }

    const input = new Input({ source: new UrlSource(this.o.url, { maxCacheSize: 48 * 1024 * 1024 }), formats: ALL_FORMATS });
    this.input = input;
    const [audioTracks, videoTrack] = await Promise.all([input.getAudioTracks(), input.getPrimaryVideoTrack()]);
    const sel = audioTracks[this.o.audioOrdinal] ?? audioTracks[0];

    let ready!: () => void;
    const sbReady = new Promise<void>((r) => (ready = r));
    const writable = new WritableStream<{ data: Uint8Array }>({
      write: async (chunk) => {
        await sbReady;
        await this.pace(gen);
        if (gen !== this.gen) return;
        await this.append(chunk.data, gen);
      },
    });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 2 }), target: new StreamTarget(writable as WritableStream) });
    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      trim: start > 0 ? { start } : undefined,
      video: (t) => (videoTrack && t.id === videoTrack.id ? {} : { discard: true }),
      audio: (t) => (sel && t.id === sel.id ? { codec: this.o.audioCodec, numberOfChannels: 2, sampleRate: 48000 } : { discard: true }),
    });
    if (gen !== this.gen) { await conversion.cancel(); return; }
    if (!conversion.isValid) throw new Error("Mediabunny could not build a playable stream from this file: " + conversion.discardedTracks.map((d) => `${d.track.type}:${d.reason}`).join(", "));
    this.conversion = conversion;

    conversion.execute().then(
      async () => {
        if (gen !== this.gen || this.destroyed) return;
        if (this.sb) await this.waitIdle(this.sb);
        if (this.ms.readyState === "open") { try { this.ms.endOfStream(); } catch { /* ignore */ } }
      },
      (e) => { if (gen === this.gen && !String(e).includes("Canceled")) this.fail(e); },
    );

    const mime = await output.getMimeType();
    if (gen !== this.gen) return;
    if (!this.sb || this.sbMime !== mime) {
      if (this.sb) { try { this.ms.removeSourceBuffer(this.sb); } catch { /* ignore */ } }
      if (!MediaSource.isTypeSupported(mime)) throw new Error(`Browser can't play ${mime}`);
      this.sb = this.ms.addSourceBuffer(mime);
      this.sbMime = mime;
      this.sb.mode = "segments";
    }
    this.sb.timestampOffset = start;
    ready();

    // clear the busy spinner as soon as the first data is buffered
    const done = () => { if (gen === this.gen) this.o.onBusy(false); };
    this.video.addEventListener("canplay", done, { once: true });
    setTimeout(done, 8000);
  }

  async destroy() {
    this.destroyed = true;
    this.gen++;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.video.removeEventListener("seeking", this.onSeeking);
    await this.stopPipeline();
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
