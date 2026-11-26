/** A song's audio as a plain HTTP(S) file (or HLS playlist) on the source's CDN. */
export interface DirectAudio {
  url: string;
  /** Headers the CDN expects (User-Agent for YouTube's per-client URLs). */
  headers: Record<string, string>;
  mime: string;
  contentLength?: number;
  durationSec: number;
  /** When the URL stops working (ms since epoch). */
  expiresAt: number;
  /** Download in ranges (YouTube throttles one long request). */
  chunked?: boolean;
  /** `url` is an HLS playlist of audio segments (SoundCloud's newer uploads). */
  hls?: boolean;
  /** Which extractor/client produced it, for logs and the admin page. */
  via: string;
}
