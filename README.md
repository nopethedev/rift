# Rift

Self-hosted, Netflix-style streaming platform. Your media, your server, your rules.

- **Next.js 16 (App Router) + TypeScript + Tailwind 4**, Prisma 7 (SQLite by default, PostgreSQL / MySQL supported)
- **Profiles** (max 5 per account, optional PIN, separate history / list / progress), admin & user roles, hashed sessions, rate limiting
- **For you**: new profiles pick 3 favourite genres; Rift learns from watch history and My List and builds personalised rows
- **TV ready**: arrow keys / D-pad navigate the whole UI (cards, rows, player controls); 10-foot mode on TV browsers
- **Subtitles** from **OpenSubtitles.com** (REST API v1), plus SRT / VTT / ASS upload and embedded tracks
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

> Docker is optional. Day to day, `npm run dev` is the fast path: migrations run on start and hot reload is on. The worker is only needed for server-side HLS transcoding (video the browser can't decode).

## Docker

```bash
cp .env.example .env          # set WORKER_TOKEN (openssl rand -hex 32), MEDIA_PATH, optionally TMDB_API_KEY
docker compose up -d --build
```

- `web` serves the app on `:3000`; `worker` is the dedicated FFmpeg service. The media folder is mounted at `/media` in both containers (same path).
- Hardware acceleration: uncomment the `devices` / `deploy` blocks on the `worker` service (VAAPI/QSV via `/dev/dri`, NVENC via the NVIDIA runtime), then choose it in Admin → Settings.
- Put a reverse proxy with HTTPS in front and set `COOKIE_SECURE=true`.

## Deploy on a VPS (prebuilt image, no build on the server)

Every push to `main` is built by GitHub Actions (`.github/workflows/docker.yml`: typecheck + tests, then amd64 and arm64 on native runners) and published to **GitHub Container Registry** as `ghcr.io/nopethedev/rift` (`latest`, `sha-<commit>`, and `1.2.3` / `1.2` for `v1.2.3` git tags). A server only pulls it:

```bash
curl -fsSL https://raw.githubusercontent.com/nopethedev/rift/main/deploy/install.sh | sh
# with HTTPS on your own domain (DNS must already point at the server, ports 80/443 open):
curl -fsSL https://raw.githubusercontent.com/nopethedev/rift/main/deploy/install.sh | RIFT_DOMAIN=rift.example.com sh
```

The installer needs Docker + the compose plugin. It creates `./rift/` with `docker-compose.yml`, a `.env` (random worker token), a `media/` folder, then pulls and starts everything. Open `http://<server-ip>:3000` and finish the setup wizard. Re-running it never overwrites your `.env`.

- **Updating**: `./update.sh` (pull + restart), e.g. nightly with cron, or `docker compose --profile auto-update up -d` to let a small updater container (Watchtower fork) check every 5 minutes. Pin a version with `RIFT_IMAGE=ghcr.io/nopethedev/rift:1.0.0` in `.env` if you prefer controlled upgrades. Migrations run on start; data lives in the `rift-data` volume and your `media/` folder.
- **One-time repo setup**: after the first workflow run, make the package public so servers can pull without logging in: GitHub → your profile/org → *Packages* → `rift` → *Package settings* → *Change visibility* → Public. Nothing else to configure; the workflow uses the built-in `GITHUB_TOKEN`. (Private package: `docker login ghcr.io` on the server with a token that has `read:packages`.)
- **Docker Hub instead/as well**: add repository secrets `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` and change `registry`/`IMAGE` in the workflow.
- The published image uses **SQLite**. For PostgreSQL/MySQL build your own with `docker compose --profile postgres up -d --build` from the repo root (the Prisma client is generated per provider).

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

### Subtitles from OpenSubtitles.com

Uses the current **opensubtitles.com** REST API (v1), not the legacy .org one.

1. Create a free account and an *API consumer* at opensubtitles.com (Profile → API consumers) to get an API key.
2. *Admin → Settings → Subtitles*: paste the key, add your username/password (needed for downloads) and your preferred languages, then *Save & test connection*.
3. Use it three ways: *Admin → Media → title → file → subtitle icon* (search + add), the player's **Subtitles → Find online…** (admins), or **Auto-fetch missing** on a title (best match per preferred language).

Results are matched by TMDB id, season/episode and the OpenSubtitles **file hash** of your video, so exact-release matches are listed first. Subtitles are converted to WebVTT and stored locally. Free accounts have a small daily download quota (shown after a download).

## Personalised recommendations

Creating a profile asks for **3 favourite genres** (kids profiles skip it; you can change them under *Manage profiles*). Rift then scores 14 taste genres per profile (`src/lib/taste.ts`):

- the picks seed the score (worth about 4 finished titles, so real history takes over quickly),
- watched titles count by completion (finished > half-watched; accidental starts are ignored) and fade with a 90-day half-life,
- My List adds a deliberate signal.

The home page shows **Top picks for <profile>** (a blend of the top genres, library titles first), **Because you like <genre>** rows (top rated) and **From your library, for you**. Anything already watched or saved is left out. Works without TMDB for library titles.

## TV and keyboard navigation

Arrow keys move a focus highlight through the whole UI (a TV remote sends arrow keys + Enter/OK), so a PC browser behaves like a TV app.

- **Browse**: ←→↑↓ move between cards, rows, buttons and the nav bar; Enter opens; the focused card grows and, after a moment, opens its trailer preview (↓ enters the preview's buttons, ↑ leaves).
- **Player**: with no control focused, ←/→ seek ±10 s and Enter plays/pauses; ↑/↓ reveal the controls and move into them (↓ from the seek bar goes to Play). Back keys (Backspace in TV mode, Tizen/webOS back) leave the player.
- **Search / forms**: arrows keep working inside text fields (↑↓ leave the field).
- **10-foot mode** (bigger type, no cursor) turns on automatically in TV browsers (Tizen, webOS, Android TV, …). Toggle with `?tv=1` / `?tv=0` or *Account menu → TV mode*.

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
