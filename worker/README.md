# Rift transcoding worker

Standalone `node:http` service that turns a media file into on-demand HLS (MPEG-TS, H.264 + AAC stereo).
The wire contract is `shared/worker-protocol.ts`.

```
npm run start:worker      # tsx --env-file-if-exists=.env worker/index.ts
npm run dev:worker        # same, with watch
npm run test:worker       # end-to-end self test (needs ffmpeg/ffprobe)
```

## Environment

| Variable | Default | |
|---|---|---|
| `WORKER_TOKEN` | — (required) | Bearer token for every endpoint except `GET /health` |
| `WORKER_PORT` | `4100` | |
| `WORKER_HOST` | `0.0.0.0` | |
| `TRANSCODE_DIR` | `./transcode` | Work dir; one sub-dir per session, stale ones are removed on startup |
| `MAX_SESSIONS` | `2` | Further `POST /sessions` get `429`; re-posting an existing id never counts |
| `SESSION_IDLE_SECONDS` | `300` | Sessions not accessed for that long are killed and deleted |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` on `PATH` | |

## Endpoints

| | |
|---|---|
| `GET /health` | `WorkerHealth` (no auth) — `hwaccels` lists encoders that passed a real test encode |
| `POST /sessions` | `StartSessionRequest` → `StartSessionResponse`. Same id + same params → `reused: true`; same id with different params (or a session in `error`) → replaced |
| `GET /sessions` | `SessionStatus[]` |
| `GET /sessions/:id` | `SessionStatus` |
| `DELETE /sessions/:id` | kills ffmpeg, deletes output |
| `GET /hls/:id/master.m3u8` | master playlist (relative URIs, `Cache-Control: no-store`) |
| `GET /hls/:id/v<height>/index.m3u8` | complete VOD playlist, 6 s segments, known up front |
| `GET /hls/:id/v<height>/seg_<n>.ts` | segment; produced on demand, may block up to 30 s (`504` on timeout), `immutable` |

Errors are JSON `{ "error": string }` (400 validation, 401 auth, 404, 429 full, 502 ffmpeg failure, 504 timeout).

## How it works

- Video is always transcoded (libx264 `veryfast`, or nvenc/vaapi/qsv/videotoolbox when requested and usable),
  with keyframes forced on every 6 s boundary, so segment *N* always covers `[6N, 6N+6)` and carries
  timestamps `6N + 1 s` regardless of which ffmpeg run made it. HDR is tone-mapped (zscale + tonemap), 10-bit is converted to 8-bit.
- Audio: AAC-LC stereo 48 kHz 160 kbit/s; multichannel is downmixed (centre/surround −3 dB, LFE dropped).
- One ffmpeg per rendition, started lazily on the first segment request (the first rendition is pre-warmed at
  `startPosition`). A request for a missing segment behind the encoder or more than 3 segments ahead of it
  restarts that rendition's ffmpeg at the requested segment; finished segments are kept and later runs skip over them.
- An encoder more than 20 segments ahead of the last requested segment is paused (SIGSTOP) and resumed when the player catches up.
