#!/usr/bin/env sh
# Pull the newest Rift image and restart on it. Safe to run from cron:
#   0 4 * * *  cd /opt/rift && ./update.sh >> update.log 2>&1
set -eu
cd "$(dirname "$0")"
PROFILES=""
grep -q '^RIFT_DOMAIN=' .env 2>/dev/null && PROFILES="--profile https"
docker compose $PROFILES pull
docker compose $PROFILES up -d --remove-orphans
docker image prune -f >/dev/null
echo "$(date -u +%FT%TZ) Rift updated"
