import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// Runtime locations. Defaults keep the old cwd-relative layout for `npm start`
// in a checkout; the container sets these to /config and /music.
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.SONGARR_DATA_DIR || 'data');
export const MUSIC_DIR = path.resolve(process.env.SONGARR_MUSIC_DIR || 'music');
export const TEMP_DIR = path.resolve(process.env.SONGARR_TEMP_DIR || path.join(DATA_DIR, 'temp'));
export const DIST_DIR = path.join(APP_DIR, 'dist');
const BIN_DIR = path.resolve(process.env.SONGARR_BIN_DIR || path.join(APP_DIR, 'bin'));

// Prefer the static builds from setup-binaries.sh, else whatever is on PATH
// (the container installs yt-dlp and ffmpeg system-wide).
export function binary(name) {
  const local = path.join(BIN_DIR, name);
  return existsSync(local) ? local : name;
}
