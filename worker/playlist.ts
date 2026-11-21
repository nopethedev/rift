// HLS math and playlist generation. Everything here is pure (no I/O).
//
// The variant playlists are complete VOD playlists computed up front from the probed duration,
// so the player sees the whole timeline immediately and can seek anywhere. ffmpeg is forced to put
// a keyframe on every SEGMENT_SECONDS boundary and the hls muxer splits exactly there, so segment
// N always covers [N*6, N*6+6) no matter which ffmpeg run produced it.
import type { SessionVariant } from "../shared/worker-protocol";

export const SEGMENT_SECONDS = 6;
/** A trailing remainder shorter than this is folded into the previous segment (it may contain no video frame). */
const MIN_TAIL_SECONDS = 0.5;

export interface SegmentLayout {
  total: number;
  /** Duration of each segment (all SEGMENT_SECONDS except the last). */
  durations: number[];
}

export function segmentLayout(durationSec: number): SegmentLayout {
  const d = Math.max(durationSec, 0.1);
  const total = Math.max(1, Math.ceil((d - MIN_TAIL_SECONDS) / SEGMENT_SECONDS));
  const durations: number[] = [];
  for (let i = 0; i < total - 1; i++) durations.push(SEGMENT_SECONDS);
  durations.push(Math.max(0.1, d - (total - 1) * SEGMENT_SECONDS));
  return { total, durations };
}

export const segmentName = (n: number) => `seg_${n}.ts`;
export const variantDirName = (height: number) => `v${height}`;

export function variantPlaylist(layout: SegmentLayout): string {
  const target = Math.ceil(Math.max(...layout.durations));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  layout.durations.forEach((dur, i) => {
    lines.push(`#EXTINF:${dur.toFixed(6)},`, segmentName(i));
  });
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** RFC 6381 codec string for the H.264 High profile at a level that covers the rendition. */
export function avcCodec(height: number, fps: number): string {
  if (height > 1080) return "avc1.640033"; // 5.1
  if (height > 720 && fps > 30.5) return "avc1.64002a"; // 4.2
  return "avc1.640028"; // 4.0
}

export function masterPlaylist(variants: SessionVariant[], fps: number, hasAudio: boolean): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const v of variants) {
    const codecs = [avcCodec(v.height, fps), ...(hasAudio ? ["mp4a.40.2"] : [])].join(",");
    const rate = fps > 0 ? `,FRAME-RATE=${fps.toFixed(3)}` : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},AVERAGE-BANDWIDTH=${Math.round(v.bandwidth * 0.75)},RESOLUTION=${v.width}x${v.height},CODECS="${codecs}"${rate}`,
      `${variantDirName(v.height)}/index.m3u8`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---- ladder ----

/** Reference max video bitrates (kbit/s) per height; other heights are scaled by pixel count. */
const RATE_TABLE: Array<[number, number]> = [
  [2160, 16000],
  [1440, 9000],
  [1080, 5000],
  [720, 2800],
  [480, 1200],
  [360, 700],
  [240, 400],
];

export function videoKbps(height: number, fps: number): number {
  let base: number;
  const exact = RATE_TABLE.find(([h]) => h === height);
  if (exact) base = exact[1];
  else {
    // nearest reference rung, scaled by pixel count (height^2)
    const [rh, rk] = RATE_TABLE.reduce((best, cur) => (Math.abs(cur[0] - height) < Math.abs(best[0] - height) ? cur : best));
    base = rk * (height / rh) ** 2;
  }
  if (fps > 31) base *= 1.4; // high frame rate needs more bits
  return Math.max(200, Math.round(base / 10) * 10);
}

export const AUDIO_KBPS = 160;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface Rendition extends SessionVariant {
  videoKbps: number;
}

/**
 * Resolve the requested ladder against the source: heights above the source are dropped, duplicates removed,
 * sorted descending; if nothing is left the source height itself is used.
 */
export function resolveLadder(ladder: number[], srcWidth: number, srcHeight: number, fps: number, hasAudio: boolean): Rendition[] {
  const srcH = even(srcHeight);
  let heights = [...new Set(ladder.filter((h) => Number.isInteger(h) && h >= 64).map(even))]
    .filter((h) => h <= srcH)
    .sort((a, b) => b - a);
  if (heights.length === 0) heights = [srcH];
  return heights.map((height) => {
    const width = even((srcWidth * height) / srcHeight);
    const vk = videoKbps(height, fps);
    const bandwidth = Math.round((vk + (hasAudio ? AUDIO_KBPS : 0)) * 1000 * 1.1);
    return { height, width, bandwidth, videoMode: "transcode" as const, videoKbps: vk };
  });
}
