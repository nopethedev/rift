# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/nopethedev/rift" \
      org.opencontainers.image.description="Rift: self-hosted streaming platform" \
      org.opencontainers.image.licenses="MIT"
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates openssl tini python3 make g++ curl \
 && rm -rf /var/lib/apt/lists/* \
 # yt-dlp (Rift Music on-demand engine A). Extractors age quickly: new images are built regularly; rebuild/pull to update.
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# DATABASE_URL decides the Prisma provider the client is generated for (sqlite by default).
ARG DATABASE_URL="file:/app/data/rift.db"
ENV DATABASE_URL=$DATABASE_URL
RUN node scripts/db.mjs generate && npm run build

FROM build AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    MEDIA_DIR=/media \
    TRANSCODE_DIR=/transcode
RUN mkdir -p /app/data /media /transcode /music-cache /sink /lavalink-config && chown -R node:node /app /media /transcode /music-cache /sink /lavalink-config
USER node
EXPOSE 3000 4100
ENTRYPOINT ["/usr/bin/tini", "--"]
# web: `npm start` (applies DB migrations, then next start) | worker: `npm run start:worker`
CMD ["npm", "start"]
