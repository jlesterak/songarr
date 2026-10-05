#!/bin/sh
# Runs as root just long enough to update yt-dlp and give PUID/PGID ownership
# of /config, then drops to PUID:PGID, like the linuxserver images.
set -e

if [ "$(id -u)" != 0 ]; then
	exec "$@"
fi

# YouTube changes often enough that a few-weeks-old yt-dlp can stop working.
if [ "${YTDLP_AUTOUPDATE:-true}" = true ]; then
	yt-dlp -U 2>&1 | tail -n 1 || true
fi

PUID=${PUID:-1000}
PGID=${PGID:-1000}

mkdir -p "$SONGARR_DATA_DIR" "$SONGARR_MUSIC_DIR"
# /config is ours; the music library may be a big shared mount, so only its top level.
chown -R "$PUID:$PGID" "$SONGARR_DATA_DIR"
chown "$PUID:$PGID" "$SONGARR_MUSIC_DIR" 2>/dev/null || true

exec su-exec "$PUID:$PGID" "$@"
