import fs from 'fs';
import os from 'os';
import path from 'path';

// Points Songarr at a throwaway data/music dir and at fake yt-dlp/ffmpeg/ffprobe
// binaries that always fail, so nothing in a test run can reach YouTube.
// Must run before the first import of anything under server/.
export function useTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'songarr-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "disabled in tests" >&2\nexit 1\n', { mode: 0o755 });
  }
  process.env.SONGARR_DATA_DIR = path.join(root, 'data');
  process.env.SONGARR_MUSIC_DIR = path.join(root, 'music');
  process.env.SONGARR_BIN_DIR = bin;
  delete process.env.SONGARR_TEMP_DIR;
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

// Silence the server's chatty console output unless SONGARR_TEST_VERBOSE=1.
export function quietConsole() {
  if (process.env.SONGARR_TEST_VERBOSE === '1') return;
  for (const k of ['log', 'warn', 'error']) console[k] = () => {};
}
