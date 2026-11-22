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
# The optional speech-to-text dependency (Whisper via ONNX Runtime) ships binaries for every platform plus GPU libraries:
# keep only what this image can use (about 100 MB instead of 750 MB).
RUN npm ci \
 && rm -rf node_modules/onnxruntime-web node_modules/onnxruntime-node/bin/napi-v6/darwin node_modules/onnxruntime-node/bin/napi-v6/win32 \
 && case "$(dpkg --print-architecture)" in amd64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/arm64;; arm64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/x64;; esac \
 && find node_modules/onnxruntime-node/bin -type f \( -name 'libonnxruntime_providers_cuda*' -o -name 'libonnxruntime_providers_tensorrt*' \) -delete 2>/dev/null; true

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
# Whisper tiny is baked in (so the first subtitle needs no internet); other models are cached in /whisper-models at runtime.
ENV WHISPER_MODEL_DIR=/opt/whisper-models \
    WHISPER_CACHE_DIR=/whisper-models
RUN mkdir -p /app/data /media /transcode /music-cache /sink /lavalink-config /opt/whisper-models /whisper-models \
 && (node scripts/fetch-whisper-model.mjs Xenova/whisper-tiny /opt/whisper-models || echo "Whisper model not baked in (offline build?): it is downloaded on first use") \
 && chown -R node:node /app /media /transcode /music-cache /sink /lavalink-config /opt/whisper-models /whisper-models
USER node
EXPOSE 3000 4100
ENTRYPOINT ["/usr/bin/tini", "--"]
# web: `npm start` (applies DB migrations, then next start) | worker: `npm run start:worker`
CMD ["npm", "start"]
