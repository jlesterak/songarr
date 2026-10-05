# syntax=docker/dockerfile:1

# --- Build the React frontend ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# --- Production node_modules only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Runtime ---
FROM node:22-alpine
# ffmpeg/ffprobe from Alpine; yt-dlp as the upstream zipapp (needs python3),
# because YouTube breaks distro-packaged yt-dlp within weeks. Node itself is
# the JS runtime yt-dlp uses for YouTube's player challenges.
ARG YTDLP_VERSION=latest
RUN apk add --no-cache ffmpeg python3 su-exec tzdata \
 && if [ "$YTDLP_VERSION" = latest ]; then \
      url=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; \
    else \
      url=https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp; \
    fi \
 && wget -q -O /usr/local/bin/yt-dlp "$url" \
 && chmod 755 /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY docker/entrypoint.sh /entrypoint.sh

ENV NODE_ENV=production \
    PORT=3001 \
    PUID=1000 \
    PGID=1000 \
    TZ=Etc/UTC \
    SONGARR_DATA_DIR=/config \
    SONGARR_MUSIC_DIR=/music \
    SONGARR_BIN_DIR=/nonexistent \
    XDG_CACHE_HOME=/config/cache \
    YTDLP_AUTOUPDATE=true

VOLUME ["/config", "/music"]
EXPOSE 3001
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/v1/status" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
