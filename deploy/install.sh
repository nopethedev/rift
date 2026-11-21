#!/usr/bin/env sh
# Rift installer for a VPS (needs Docker with the compose plugin). Safe to re-run: it never overwrites an existing .env.
#   curl -fsSL https://raw.githubusercontent.com/nopethedev/rift/main/deploy/install.sh | sh
# Options (environment variables):
#   RIFT_DIR=/opt/rift      install folder (default: ./rift)
#   RIFT_DOMAIN=rift.example.com   enable automatic HTTPS (domain must point at this server)
#   TMDB_API_KEY=...        optional, can also be set later in the web UI
set -eu

RAW="${RIFT_RAW_BASE:-https://raw.githubusercontent.com/nopethedev/rift/main/deploy}"
DIR="${RIFT_DIR:-rift}"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [ -z "${RIFT_SKIP_START:-}" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first: curl -fsSL https://get.docker.com | sh"
  docker compose version >/dev/null 2>&1 || die "The Docker compose plugin is missing (https://docs.docker.com/compose/install/linux/)."
fi

mkdir -p "$DIR/media"
cd "$DIR"
say "Installing into $(pwd)"

for f in docker-compose.yml Caddyfile update.sh; do
  curl -fsSL "$RAW/$f" -o "$f" || die "Could not download $f from $RAW"
done
chmod +x update.sh

if [ -f .env ]; then
  say "Keeping your existing .env"
else
  if command -v openssl >/dev/null 2>&1; then token="$(openssl rand -hex 32)"; else token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  {
    echo "WORKER_TOKEN=$token"
    echo "MEDIA_PATH=./media"
    echo "RIFT_PORT=3000"
    echo "TMDB_API_KEY=${TMDB_API_KEY:-}"
    if [ -n "${RIFT_DOMAIN:-}" ]; then
      echo "RIFT_DOMAIN=$RIFT_DOMAIN"
      echo "RIFT_BIND=127.0.0.1"
      echo "COOKIE_SECURE=true"
    else
      echo "COOKIE_SECURE=false"
    fi
  } > .env
  chmod 600 .env
  say "Created .env with a random worker token"
fi

# The container runs as uid 1000 and must be able to write to the media folder (uploads, downloads).
if [ "$(id -u)" = "0" ]; then chown 1000:1000 media 2>/dev/null || true; else chmod a+rwx media 2>/dev/null || true; fi

[ -n "${RIFT_SKIP_START:-}" ] && { say "Files ready (start skipped)."; exit 0; }

PROFILE=""
grep -q '^RIFT_DOMAIN=.' .env && PROFILE="--profile https"
say "Pulling the image and starting Rift"
docker compose $PROFILE pull
docker compose $PROFILE up -d

if grep -q '^RIFT_DOMAIN=.' .env; then URL="https://$(grep '^RIFT_DOMAIN=' .env | cut -d= -f2)"; else URL="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):3000"; fi
say "Rift is starting: open $URL and finish the setup wizard."
echo "   Update later:       cd $(pwd) && ./update.sh"
echo "   Auto-update:        docker compose --profile auto-update up -d"
echo "   Logs:               docker compose logs -f web"
