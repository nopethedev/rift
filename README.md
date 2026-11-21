# Rift

Self-hosted, Netflix-style streaming platform. Your media, your server, your rules.

- **Next.js 16 (App Router) + TypeScript + Tailwind 4**, Prisma 7 (SQLite by default, PostgreSQL / MySQL supported)
- **Profiles** (max 5 per account, optional PIN, separate history / list / progress), admin & user roles, hashed sessions, rate limiting
- **TMDB** discovery, trailers, hover previews (700 ms, muted YouTube trailer), local vs. discover-only badges
- **Player**: direct play → **Mediabunny** in-browser remux/transcode (Dolby Digital / Digital Plus → AAC or Opus) → **FFmpeg HLS** worker for unsupported video
- **WebTorrent** download manager, torrent search (`torrent-search-api`, Torznab, Internet Archive), automatic library import & TMDB matching
- **Admin** (`/admin`): overview, media, add-media wizard, downloads, active streams, users, storage, settings

## Quick start (development)

```bash
cp .env.example .env          # set TMDB_API_KEY (optional, can be added in the UI) and WORKER_TOKEN
npm install
npm run dev                   # applies DB migrations, starts Next.js on :3000
npm run dev:worker            # FFmpeg worker on :4100 (needed only for server transcoding)
```

Open <http://localhost:3000> — the first-run wizard creates the administrator, connects TMDB, sets storage folders and checks FFmpeg.

Requirements: Node ≥ 22 and FFmpeg/FFprobe on the `PATH`.

## Docker

```bash
cp .env.example .env          # set WORKER_TOKEN (openssl rand -hex 32), MEDIA_PATH, optionally TMDB_API_KEY
docker compose up -d --build
```

- `web` serves the app on `:3000`; `worker` is the dedicated FFmpeg service. The media folder is mounted at `/media` in both containers (same path).
- Hardware acceleration: uncomment the `devices` / `deploy` blocks on the `worker` service (VAAPI/QSV via `/dev/dri`, NVENC via the NVIDIA runtime), then choose it in Admin → Settings.
- Put a reverse proxy with HTTPS in front and set `COOKIE_SECURE=true`.

### Other databases

The Prisma provider is derived from `DATABASE_URL` by `scripts/db.mjs`:

| URL | Provider | Schema handling |
| --- | --- | --- |
| `file:./data/rift.db` (default) | SQLite | committed SQL migrations (`prisma migrate deploy`) |
| `postgresql://…` | PostgreSQL | `prisma db push` on start |
| `mysql://…` | MySQL / MariaDB | `prisma db push` on start |

Set `DATABASE_URL` **before** `npm run build` / `docker compose build` (the client is generated for that provider). With compose: `docker compose --profile postgres up -d --build` and `DATABASE_URL=postgresql://rift:rift@postgres:5432/rift`.

## How playback works

| Situation | Mode | Where the work happens |
| --- | --- | --- |
| MP4/WebM, browser-native video + audio, default track | **Direct play** (HTTP range) | none |
| Dolby Digital / Digital Plus (AC-3 / E-AC-3) audio, MKV/AVI/TS remux, alternate audio track | **Mediabunny** | viewer's browser: video copied, audio decoded (`@mediabunny/ac3`) and encoded to stereo AAC or Opus (WebCodecs), fed to MSE as fragmented MP4 |
| Video codec/bit-depth the browser cannot decode (HEVC on some browsers, 10-bit H.264, …), quality < original, or no MediaSource (iOS) | **FFmpeg HLS** | `worker/`: adaptive ladder, on-demand seeking, optional NVENC/VAAPI/QSV/VideoToolbox |

Mediabunny is *enforced* for DD/DD+ audio (setting *Convert Dolby Digital in the browser*, on by default): the server never transcodes that audio when the video is playable natively. In the HLS fallback the worker has to touch the whole stream anyway and encodes AAC.

## Adding media

*Admin → Add media* wizard:

1. **Upload my own media** — pick a movie/show on TMDB, drop files (episodes are mapped from `S01E02` in names, editable), subtitles with matching names are attached. Files stream straight to disk.
2. **Search & torrent** — pick a title, search indexers, choose a result, tick the files you want, download. Finished downloads are scanned and linked to the chosen title automatically.
3. **Import a folder** — scan an existing server directory; titles are matched by filename + TMDB.

Subtitles: SRT, VTT, ASS/SSA (converted to WebVTT; embedded text tracks are extracted on import).

### On-demand streaming (torrent → player, no library import)

*Add media → Search & torrent → **Stream*** (or **Stream now** after pasting a magnet / `.torrent`, or **Stream via torrent** on a discovery title page). Admin only.

1. Rift fetches the metadata and picks the video file (season packs ask you to choose an episode).
2. **Pre-buffer:** only the start (≈0.5 % of the file, 1.5–6 MB) and the last 2 MB (container index) are requested, at top priority, with extra public trackers for fast peer discovery.
3. The headers are probed and the player starts. Playback is served as HTTP range requests straight from the torrent with a 24 MB critical read-ahead window that follows the playhead; seeking re-prioritises the pieces at the new position. The rest of the file downloads in the background.
4. The player sends a **heartbeat every 15 s**. With no heartbeat/activity for `STREAM_IDLE_SECONDS` (default **60**) the torrent is destroyed and its files are deleted from `<downloadDir>/.stream-cache`. Leftovers from a crash are wiped on boot. *Active streams* shows live sessions with *Stop & delete*.

Playback uses direct play or in-browser Mediabunny (so DD+ still works); video the browser can't decode can't be server-transcoded from a partial file — add that torrent to the library instead. Tunables: `STREAM_IDLE_SECONDS`, `STREAM_PREBUFFER_MB`, `STREAM_MAX_SESSIONS` (default 3).

> Only download or upload content you own or are licensed to use. Nothing is ever downloaded automatically from TMDB discovery results.

## Layout

```
src/app            Next.js routes (UI + API)        shared/   probe, subtitles, worker protocol (web + worker)
src/components     UI, player, hover preview        worker/   FFmpeg HLS service
src/server         auth, TMDB, catalog, torrents,   prisma/   schema + SQLite migrations
                   library importer/scanner         scripts/  db helper
```

## Scripts

`npm run dev | build | start` · `npm run start:worker` · `npm run db:setup` · `npm run db:migrate:dev -- <name>` (SQLite) · `npm test` · `npm run test:worker` · `npm run typecheck`
