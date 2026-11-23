#!/usr/bin/env bash
# Full-stack Rift Music E2E: real Next.js + worker + FFmpeg + yt-dlp + headless Chromium (+ a real Lavalink node when
# LAVALINK_JAR is set). Uses a throw-away database and data dir. Only the yt-dlp *search* step is faked (no internet needed);
# all downloading/inspection is the real yt-dlp against a local HTTP server.
#
#   PLAYWRIGHT_RESOLVE_FROM=/path/with/node_modules/ LAVALINK_JAR=/path/Lavalink.jar scripts/e2e-music/run.sh
#
# Needs: ffmpeg, yt-dlp, python3, Node >= 22, Playwright + Chromium; Java + keytool for the Lavalink part.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/e2e-music"
export E="${E2E_DIR:-$(mktemp -d)}"
export E2E_FILE_BASE="http://127.0.0.1:8099"
export PLAYWRIGHT_RESOLVE_FROM="${PLAYWRIGHT_RESOLVE_FROM:-/opt/node-tools/}"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; pkill -P $$ 2>/dev/null || true
  # npm/tsx spawn grandchildren that a plain kill of the wrapper leaves running (and holding the ports)
  pkill -f "next-server" 2>/dev/null || true; pkill -f "next dev -p 3100" 2>/dev/null || true; pkill -f "worker/index.ts" 2>/dev/null || true
}
trap cleanup EXIT
cd "$ROOT"
if curl -fs -o /dev/null http://localhost:3100/login 2>/dev/null; then echo "port 3100 is already in use (stale dev server?); stop it first"; exit 1; fi
mkdir -p "$E/transcode" "$E/data"
bash "$HERE/fixtures.sh"
cp "$HERE/ytdlp-wrap.py" "$E/ytdlp-wrap.py" && chmod +x "$E/ytdlp-wrap.py"

node "$HERE/fake-catalog.mjs" 8098 "$E" >"$E/catalog.log" 2>&1 & PIDS+=($!)
python3 -m http.server 8099 --bind 127.0.0.1 --directory "$E/files" >/dev/null 2>&1 & PIDS+=($!)
env WORKER_TOKEN=e2e WORKER_PORT=4100 WORKER_HOST=127.0.0.1 TRANSCODE_DIR="$E/transcode" YTDLP_PATH="$E/ytdlp-wrap.py" \
  SINK_PUBLIC_HOST=localhost SINK_PUBLIC_IP=127.0.0.1 SINK_WSS_PORT=24443 SINK_UDP_PORT=24444 SINK_TLS_DIR="$E/sink" \
  npx tsx worker/index.ts >"$E/worker.log" 2>&1 & PIDS+=($!)
env TMDB_BASE_URL=http://localhost:8098/tmdb DEEZER_API_URL=http://localhost:8098 ITUNES_API_URL=http://localhost:8098/itunes WIKIPEDIA_API_URL=http://localhost:8098/wiki MUSIC_ART_HOSTS=localhost:8098 \
  DATABASE_URL="file:$E/rift.db" DATA_DIR="$E/data" MEDIA_DIR="$E/media" WORKER_URL=http://127.0.0.1:4100 WORKER_TOKEN=e2e \
  npm run dev -- -p 3100 >"$E/web.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 90); do curl -fs -o /dev/null http://localhost:3100/login && break; sleep 1; done
curl -fs -o /dev/null http://localhost:3100/login || { echo "web server did not start; see $E/web.log"; exit 1; }
for _ in $(seq 1 30); do [ -s "$E/sink/cert.pem" ] && break; sleep 1; done

rc=0
DEFAULT_PARTS="part1-local part10-resilience part2-ondemand part4-security part6-discover part8-mobile part9-presence"
if [ -n "${WHISPER_MODEL_DIR:-}" ]; then DEFAULT_PARTS="$DEFAULT_PARTS part7-subtitles"; else echo "(part7-subtitles skipped: set WHISPER_MODEL_DIR to a folder containing Xenova/whisper-tiny)"; fi
for part in ${PARTS:-$DEFAULT_PARTS}; do
  echo "=== $part"; node "$HERE/$part.mjs" || rc=1
done
if [ -n "${LAVALINK_JAR:-}" ] && command -v java >/dev/null; then
  # The JVM must trust the audio bridge's self-signed certificate (same thing deploy/lavalink-trust.sh does in Docker).
  mkdir -p "$E/ll" && cd "$E/ll"
  CACERTS="${LAVALINK_CACERTS:-$(sed -n 's/.*trustStore=\([^ ]*\).*/\1/p' <<<"${JAVA_TOOL_OPTIONS:-}")}"
  [ -n "$CACERTS" ] || CACERTS="$(dirname "$(readlink -f "$(command -v java)")")/../lib/security/cacerts"
  cp "$CACERTS" trust.jks && keytool -importcert -noprompt -alias rift-bridge -file "$E/sink/cert.pem" -keystore trust.jks -storepass changeit >/dev/null 2>&1
  printf 'server:\n  port: 24333\n  address: 127.0.0.1\nlavalink:\n  server:\n    password: "e2e"\n    sources:\n      http: true\n' > application.yml
  java -Djavax.net.ssl.trustStore="$E/ll/trust.jks" -Djavax.net.ssl.trustStorePassword=changeit -jar "$LAVALINK_JAR" >ll.log 2>&1 & PIDS+=($!)
  cd "$ROOT"
  for _ in $(seq 1 60); do curl -fs -o /dev/null -H 'Authorization: e2e' http://127.0.0.1:24333/version && break; sleep 1; done
  echo "=== part3-lavalink"; node "$HERE/part3-lavalink.mjs" || rc=1
else
  echo "=== part3-lavalink skipped (set LAVALINK_JAR and install Java to run it)"
fi
pkill -f 'Lavalink.jar' 2>/dev/null || true
# E2E_HOLD=1: keep the stack running (for debugging) until $E/hold is removed
if [ -n "${E2E_HOLD:-}" ]; then touch "$E/hold"; echo "holding: rm $E/hold to stop"; while [ -e "$E/hold" ]; do sleep 2; done; fi
exit $rc
