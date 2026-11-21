// Shared (web + worker): ffprobe wrapper built on fluent-ffmpeg. No Next.js / Prisma imports allowed here.
import ffmpeg from "fluent-ffmpeg";

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

export interface ProbeStream {
  index: number; // absolute ffprobe stream index
  type: "video" | "audio" | "subtitle";
  codec: string; // ffprobe codec_name: h264, hevc, vp9, av1, aac, eac3, ac3, opus, subrip, ass, hdmv_pgs_subtitle...
  profile?: string;
  language?: string;
  title?: string;
  default?: boolean;
  forced?: boolean;
  // video
  width?: number;
  height?: number;
  fps?: number;
  pixFmt?: string;
  bitDepth?: number;
  hdr?: boolean;
  // audio
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  // common
  bitRate?: number;
  /** subtitles only: true for text-based codecs we can convert to WebVTT */
  textBased?: boolean;
}

export interface ProbeResult {
  path: string;
  container: string; // ffprobe format_name, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2"
  durationSec: number;
  size: number;
  bitrate: number;
  streams: ProbeStream[];
}

const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : undefined;
};

function fps(r?: string): number | undefined {
  if (!r || r === "0/0") return undefined;
  const [a, b] = r.split("/").map(Number);
  return b ? Math.round((a / b) * 1000) / 1000 : num(r);
}

export function probeFile(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, ["-show_format", "-show_streams"], (err, data) => {
      if (err) return reject(err);
      const streams: ProbeStream[] = [];
      for (const s of data.streams) {
        const type = s.codec_type;
        if (type !== "video" && type !== "audio" && type !== "subtitle") continue;
        // skip embedded cover art
        if (type === "video" && s.disposition?.attached_pic) continue;
        const codec = s.codec_name ?? "unknown";
        const tags = (s.tags ?? {}) as Record<string, string>;
        const transfer = (s as any).color_transfer as string | undefined;
        streams.push({
          index: s.index,
          type,
          codec,
          profile: s.profile === undefined ? undefined : String(s.profile),
          language: tags.language && tags.language !== "und" ? tags.language : undefined,
          title: tags.title,
          default: !!s.disposition?.default,
          forced: !!s.disposition?.forced,
          width: s.width,
          height: s.height,
          fps: type === "video" ? fps(s.avg_frame_rate || s.r_frame_rate) : undefined,
          pixFmt: s.pix_fmt,
          bitDepth: num(s.bits_per_raw_sample) ?? (s.pix_fmt?.includes("10") ? 10 : undefined),
          hdr: transfer === "smpte2084" || transfer === "arib-std-b67" || undefined,
          channels: s.channels,
          channelLayout: s.channel_layout,
          sampleRate: num(s.sample_rate),
          bitRate: num(s.bit_rate),
          textBased: type === "subtitle" ? TEXT_SUBS.has(codec) : undefined,
        });
      }
      resolve({
        path,
        container: data.format.format_name ?? "unknown",
        durationSec: num(data.format.duration) ?? 0,
        size: num(data.format.size) ?? 0,
        bitrate: num(data.format.bit_rate) ?? 0,
        streams,
      });
    });
  });
}

export const firstVideo = (p: ProbeResult) => p.streams.find((s) => s.type === "video");
export const firstAudio = (p: ProbeResult) => p.streams.find((s) => s.type === "audio" && s.default) ?? p.streams.find((s) => s.type === "audio");
