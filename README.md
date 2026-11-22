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
- **Rift Music** (`/music`): your own library (MP3, FLAC, AAC, OGG, WAV, Opus) plus optional on-demand streaming (yt-dlp or Lavalink), smart queue, Spotify playlist import
- **Admin** (`/admin`): overview, media, add-media wizard, downloads, active streams, users, storage, settings, music

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
docker compose up -d          # pulls the prebuilt ghcr.io/nopethedev/rift:latest, no build
```

Update: `docker compose pull && docker compose up -d` (`up` also re-checks for a newer image on every run). Pin a build with `RIFT_IMAGE=ghcr.io/nopethedev/rift:sha-<commit>` in `.env`.

To build from this checkout instead (your own changes, or PostgreSQL/MySQL), add the build override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
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
- The published image uses **SQLite**. For PostgreSQL/MySQL build your own with `docker compose -f docker-compose.yml -f docker-compose.build.yml --profile postgres up -d --build` from the repo root (the Prisma client is generated per provider).

### Other databases

The Prisma provider is derived from `DATABASE_URL` by `scripts/db.mjs`:

| URL | Provider | Schema handling |
| --- | --- | --- |
| `file:./data/rift.db` (default) | SQLite | committed SQL migrations (`prisma migrate deploy`) |
| `postgresql://…` | PostgreSQL | `prisma db push` on start |
| `mysql://…` | MySQL / MariaDB | `prisma db push` on start |

Set `DATABASE_URL` **before** `npm run build` / `docker compose build` (the client is generated for that provider). With compose: `docker compose -f docker-compose.yml -f docker-compose.build.yml --profile postgres up -d --build` and `DATABASE_URL=postgresql://rift:rift@postgres:5432/rift`.

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

The home page shows **Top picks for <profile>** (a blend of the top genres, library titles first), **Because you like <genre>** rows (top rated) and **From your library, for you**. Anything already watched or saved is left out. Recommendations are limited to recent releases (popular picks: last 10 years, top-rated: last 20), so you don't get a "best of all time" list. Works without TMDB for library titles.

## TV and keyboard navigation

Arrow keys move a focus highlight through the whole UI (a TV remote sends arrow keys + Enter/OK), so a PC browser behaves like a TV app.

- **Browse**: ←→↑↓ move between cards, rows, buttons and the nav bar; Enter opens; the focused card grows and, after a moment, expands in place to 16:9 with its trailer (↓ enters its Play / My List / info buttons, ↑ leaves).
- **Player**: with no control focused, ←/→ seek ±10 s and Enter plays/pauses; ↑/↓ reveal the controls and move into them (↓ from the seek bar goes to Play). Back keys (Backspace in TV mode, Tizen/webOS back) leave the player.
- **Search / forms**: arrows keep working inside text fields (↑↓ leave the field).
- **10-foot mode** (bigger type, no cursor) turns on automatically in TV browsers (Tizen, webOS, Android TV, …). Toggle with `?tv=1` / `?tv=0` or *Account menu → TV mode*.

### On-demand streaming (torrent → player, no library import)

*Add media → Search & torrent → **Stream*** (or **Stream now** after pasting a magnet / `.torrent`, or **Stream via torrent** on a discovery title page). Admin only.

1. Rift fetches the metadata and picks the video file (season packs ask you to choose an episode).
2. **Pre-buffer:** only the start (≈0.5 % of the file, 1.5–6 MB) and the last 2 MB (container index) are requested, at top priority, with extra public trackers for fast peer discovery.
3. The headers are probed and the player starts. Playback is served as HTTP range requests straight from the torrent with a 24 MB critical read-ahead window that follows the playhead; seeking re-prioritises the pieces at the new position. The rest of the file downloads in the background.
4. The player sends a **heartbeat every 15 s**. With no heartbeat/activity for `STREAM_IDLE_SECONDS` (default **60**) the torrent is destroyed and its files are deleted from `<downloadDir>/.stream-cache`. Leftovers from a crash are wiped on boot. *Active streams* shows live sessions with *Stop & delete*.

Playback uses direct play or in-browser Mediabunny (so DD+ still works); video the browser can't decode can't be server-transcoded from a partial file — add that torrent to the library instead. Tunables: `STREAM_IDLE_SECONDS`, `STREAM_PREBUFFER_MB`.

**Play on any title.** Titles that aren't in your library get a **Play** button (poster preview, title page, and each episode of a show). Rift looks the title up on TMDB, searches your torrent sources, picks the release that will play best in a browser (1080p/720p H.264, AAC or Dolby Digital(+) audio, healthy seeders, sane size; it avoids CAMs, 10-bit, HDR/remux and DTS/TrueHD) and starts the stream. Season packs are handled: the right episode file is picked automatically. If a source is dead, *Try another source* uses the next best.

**Limits (Settings → On-demand streaming).** *Max simultaneous streams* (0 turns the feature off; default 3, from `STREAM_MAX_SESSIONS`) protects small disks: every active stream keeps a temporary copy, deleted about a minute after the viewer leaves. Over the limit, viewers are told to try again shortly. *Who can start a stream*: administrators only (default) or everyone with an account. Users only ever reach streams they started, and they cannot submit their own magnet links; the server does the searching. The same torrent requested twice shares one stream and one slot.

**Audio:** Dolby Digital / Digital Plus (DD+ 5.1 etc.) is decoded in the browser with Mediabunny and re-encoded to **AAC** in real time (seeking works; the encoder restarts at the new position). Browsers without an AAC encoder (e.g. some Chromium builds, Linux) fall back to Opus.

> Only download or upload content you own or are licensed to use. Nothing is ever downloaded automatically from TMDB discovery results.

## Rift Music

After you sign in and pick a profile, an **app picker** asks whether you want **Stream** (movies / TV) or **Music** (shown once each time the browser is opened; *Switch app* is in the account menu, and a direct `/music` link skips it). Music has its own Spotify-style layout: a left sidebar (Home, Search, Your Library, Liked songs, your playlists), a top search bar, a persistent player (it keeps playing while you browse) and a per-profile queue that survives reloads, with shuffle / repeat / autoplay, playlists, search and recommendations.

### Home feed, album art and artist pages (online metadata)
With **Admin → Music → Settings → "Online album art, artist info and music feed"** on (default), Rift asks Deezer's public API (no key), iTunes and Wikipedia for **metadata only**. Only artist / album / title text is sent, never your listening, and no audio comes from these services.

- **Home**: quick picks (Liked songs, playlists, albums you played lately), your library shelves, then online shelves: *Trending now*, *New releases*, *Popular artists*, *Top albums*, *More from / Fans of …* (built from your play history), *Top <your favourite genre>* and *Browse all* genres. Click a song to play it: the library is used first, otherwise it is streamed on demand (so the on-demand rules and the rights confirmation below still apply).
- **Album art**: songs with no cover get one automatically after a scan or upload: one lookup per album (Deezer, iTunes as a fallback), stored in your data folder, never replacing embedded covers; misses are retried after a week. *Admin → Music → Fetch missing album art* runs it now. Remote artwork shown in the UI is fetched and cached by the server (allow-listed image hosts only), so browsers never contact third parties.
- **Artist pages** (`/music/artists/<name>`): a collapsible **info panel on the left** (photo, fans, biography from Wikipedia with *Show more*, similar artists, what you own; each section expands, and the whole panel collapses to a rail), then popular songs, your library songs, the discography (albums / singles & EPs) and *Fans also like*. Albums (`/music/release/<id>`) and genres (`/music/genre/<id>`) have pages too.

### Liked songs, your library, and matching songs yourself
Every song row has a **heart**: it adds the song to **Liked songs** (your saved library, per profile). Songs you don't own stay on-demand references: audio is never stored permanently. If a song (in a Spotify import, a playlist or Liked songs) isn't matched, or is matched wrongly, press **Match** and pick the right recording from your library or from the on-demand search; the choice is pinned, survives *Check sources* and Spotify re-syncs, and can be cleared.

### Where songs come from (Admin → Music → Settings)

| Playback source | Behaviour |
| --- | --- |
| **Local library** | Only your uploaded / imported files. |
| **On-demand** | Every song is fetched when needed from an external source (no library required). |
| **Hybrid** | Library first; anything not in the library is fetched on demand. |

**On-demand engine**: *Both (recommended)* tries **Lavalink first and falls back to yt-dlp** whenever Lavalink has no match, its node/bridge is down or the track fails (with no Lavalink node configured it is simply yt-dlp); or pick *yt-dlp only* / *Lavalink only*. Search uses the same order.

**Local library.** Upload on *Admin → Music* (streamed straight to disk) or point Rift at folders (`/media/music` by default; rescanned every 10 minutes). MP3, FLAC, AAC/M4A, OGG, WAV and Opus are indexed with their tags, cover art (embedded or `cover.jpg`), artist, album, genre and year. Files play directly with HTTP Range (seeking). If the browser reports it can't decode a codec (or the file is WMA, ALAC, …) the worker converts it with FFmpeg on the fly; seeking in a converted stream restarts it at the new offset.

**On-demand.** The web app never does the heavy work. It asks the worker (`worker/music/`), which finds a matching recording, pulls the audio, runs it through FFmpeg into a **temporary cache file that browsers can start playing while it is still being written**, and serves it back (full Range seeking once the file is complete):

- **Matching** (`shared/music-match.ts`): scores title, artist and duration, prefers "Topic"/official uploads, and rejects remixes, covers, live recordings, karaoke, sped-up/slowed versions and non-music results unless you asked for one (the requested title says "(Live)", …).
- **Preloading** the next *N* songs of the queue (default 2). When the queue changes (skip, remove, reorder, shuffle) preloads that are no longer needed are cancelled and their partial files deleted. One download slot is always kept free for the song being played, so preloads never delay it.
- **No duplicate work**: concurrent listeners wanting the same recording share one download; resolving the same song twice is cached.
- **Bounded cache** (`maxCacheMB`): least recently used unused audio is evicted first; if everything is in use new fetches fail with a clear message instead of filling the disk.
- **Cleanup**: audio is deleted after nobody needs it (finished, skipped, listener left/crashed: holds expire without a heartbeat) plus a short grace period so "previous" is instant. Leftovers from a crashed worker are removed on start. Streamed tracks are **never** imported into the library.
- **Failure recovery**: a failing source falls through to the next-best match; the player retries once, then skips (max 3 in a row) with the reason shown. Limits: concurrent listeners and concurrent downloads.
- **Settings** (all under `/admin/music/settings`): playback source, engine, preloading on/off + count, cache directory, maximum cache size, automatic cleanup (+ grace), format (MP3 / AAC / Opus) and bitrate, concurrent listeners / downloads.

> **Rights.** On-demand playback stays off until an administrator ticks *"I confirm I may download and stream audio from the sources enabled"*. With the default policy (**open-licensed only**) yt-dlp results are checked for a Creative Commons / public-domain licence and anything else is refused; choosing *attested* skips the check and makes you responsible. Rift never downloads Spotify audio or touches DRM. Candidate URLs are signed by the server, so a client can't point the server at arbitrary URLs, and pasting direct links is admin-only.

### Engine A: yt-dlp
Needs `yt-dlp` on the worker's `PATH` (the Docker image includes it; set `YTDLP_PATH` otherwise). Search providers: SoundCloud and/or YouTube. Source extractors change often, so keep the image / binary current (`pip install -U yt-dlp`).

### Engine B: Lavalink
Lavalink does **not** expose an audio stream: it only sends Opus to a Discord-style *voice connection*. Rift therefore ships an **audio bridge** (`worker/music/voice-sink.ts`): a minimal voice server (gateway v8 over TLS + UDP/RTP, `aead_aes256_gcm_rtpsize`) that Lavalink "joins" instead of Discord. The Opus packets it receives are re-wrapped as Ogg Opus, run through FFmpeg and cached exactly like yt-dlp audio.

- Any number of nodes (Admin → Music → Settings → Lavalink): URL, password, search prefix, health/version test; searches fail over between online nodes. Allowed source types are configurable (Lavalink can't report licences, so only list sources you may stream).
- Bundled node: `docker compose --profile lavalink up -d`, then set `LAVALINK_URL=http://lavalink:2333` (and `LAVALINK_PASSWORD`) in `.env`. Plugins are listed in the admin page and written to the node's `application.yml` (restart the container to apply).
- **Limitations (by design of Lavalink):** playback is captured **in real time**, so a song is fully seekable only after its capture finished (seeking ahead of it waits for that); preloads occupy a download slot for the length of the song. Nodes must reach the worker (TCP 4443, UDP 4444; `SINK_PUBLIC_HOST` / `SINK_PUBLIC_IP`) and **trust its self-signed certificate** (compose handles this for the bundled node; remote nodes need the certificate in their Java trust store, or supply your own CA-signed certificate via `SINK_TLS_DIR`). Discord's DAVE end-to-end encryption is never negotiated (there is no Discord).
- **What has been tested end to end:** against a real Lavalink 4.2.2 node (HTTP-source tracks), the bridge, FFmpeg, cache, API and a real Chromium (see below). Searching through Lavalink's YouTube/SoundCloud sources and the Docker `--profile lavalink` wiring were *not* run in the development environment (no internet / Docker daemon there).

### Spotify playlists
*Music → Playlists → Import from Spotify*: paste a public playlist or album link. Rift imports names, artists, artwork and order (metadata only), matches each track to your library, then checks the on-demand source for the rest and marks every entry **in library / on-demand / unavailable** (with the reason). *Sync* re-imports the link; *Check sources* re-runs the availability check. Without credentials Rift reads the first 100 tracks of public playlists from Spotify's embed page; with a client id/secret (Admin → Music) it imports whole playlists through the Web API. Private playlists are not supported. (The Spotify fetching code is unit-tested against recorded page/API shapes; it could not be run against Spotify from the development environment.)

### Tests
`npm test` runs the matcher, queue logic, candidate signing, Spotify mappers and the worker pipeline (real FFmpeg, a synthetic engine: live-tail streaming, Range, de-duplication, preload cancel, cleanup, limits, eviction). With `yt-dlp` installed and `LAVALINK_JAR=/path/Lavalink.jar` (+ Java) the same suite also runs real yt-dlp and a real Lavalink node end to end (`worker/music/e2e.test.ts`). `scripts/e2e-music/` drives the whole stack in headless Chromium (`PARTS="part1-local part6-discover" scripts/e2e-music/run.sh` runs a subset); `fake-catalog.mjs` stands in for Deezer / iTunes / Wikipedia so the feed, album art, artist pages and liked songs are tested without internet.

## Layout

```
src/app            Next.js routes (UI + API)        shared/   probe, subtitles, worker protocol (web + worker)
src/components     UI, player, hover preview        worker/   FFmpeg HLS service
src/server         auth, TMDB, catalog, torrents,   prisma/   schema + SQLite migrations
                   library importer/scanner         scripts/  db helper
```

## Scripts

`npm run dev | build | start` · `npm run start:worker` · `npm run db:setup` · `npm run db:migrate:dev -- <name>` (SQLite) · `npm test` · `npm run test:worker` · `npm run typecheck`
