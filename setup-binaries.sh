#!/bin/bash
set -e

# Create bin directory
mkdir -p bin

echo "=== Songarr Local Binaries Installer ==="

# Download yt-dlp
if [ ! -f bin/yt-dlp ]; then
  echo "[+] Downloading yt-dlp..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
  chmod +x bin/yt-dlp
  echo "[+] yt-dlp installed successfully."
else
  echo "[✓] yt-dlp already exists."
fi

# Download ffmpeg & ffprobe
if [ ! -f bin/ffmpeg ] || [ ! -f bin/ffprobe ]; then
  echo "[+] Downloading ffmpeg static build..."
  curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o bin/ffmpeg.tar.xz
  echo "[+] Extracting ffmpeg..."
  mkdir -p bin/ffmpeg_temp
  tar -xf bin/ffmpeg.tar.xz -C bin/ffmpeg_temp --strip-components=1
  mv bin/ffmpeg_temp/ffmpeg bin/ffmpeg
  mv bin/ffmpeg_temp/ffprobe bin/ffprobe
  rm -rf bin/ffmpeg_temp bin/ffmpeg.tar.xz
  chmod +x bin/ffmpeg bin/ffprobe
  echo "[+] ffmpeg and ffprobe installed successfully."
else
  echo "[✓] ffmpeg and ffprobe already exist."
fi

echo "=== Verification ==="
echo "yt-dlp version:"
./bin/yt-dlp --version
echo "ffmpeg version:"
./bin/ffmpeg -version | head -n 1
echo "====================="
