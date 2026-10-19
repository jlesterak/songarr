#!/bin/sh
# Build the Songarr image on your own machine and smoke-test it: the container
# must come up healthy with working ffmpeg, ffprobe and yt-dlp.
#
#   scripts/build-local.sh            this machine's architecture (songarr:local)
#   scripts/build-local.sh --arm64    linux/arm64 under emulation (songarr:arm64)
#   scripts/build-local.sh --all      both
#
# Needs Docker. --arm64 on an x86 laptop also needs buildx and QEMU; once per
# machine: docker run --privileged --rm tonistiigi/binfmt --install arm64
# (an arm64 build under emulation takes several times longer than a native one).
set -eu
cd "$(dirname "$0")/.."

native=1 arm=0
case "${1:-}" in
  "") ;;
  --arm64) native=0 arm=1 ;;
  --all) arm=1 ;;
  *) echo "usage: $0 [--arm64|--all]" >&2; exit 2 ;;
esac

check() { # image platform
  name="songarr-smoke-$$"
  echo "== smoke test $1 ($2)"
  docker run -d --rm --name "$name" --platform "$2" -e YTDLP_AUTOUPDATE=false "$1" >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null)" = healthy ]; do
    i=$((i + 1))
    if [ $i -gt 60 ]; then echo "not healthy after 5 min" >&2; docker logs "$name" | tail -20; exit 1; fi
    sleep 5
  done
  docker exec "$name" sh -c 'uname -m && ffmpeg -version | head -1 && ffprobe -version | head -1 && yt-dlp --version'
  docker rm -f "$name" >/dev/null
  trap - EXIT
  echo "ok   $1 ($2)"
}

if [ $native = 1 ]; then
  docker build -t songarr:local .
  check songarr:local "linux/$(docker version -f '{{.Server.Arch}}')"
fi
if [ $arm = 1 ]; then
  docker buildx build --platform linux/arm64 -t songarr:arm64 --load .
  check songarr:arm64 linux/arm64
fi
