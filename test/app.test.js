import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const { librarySize } = await import('../server/app.js');
after(() => env.cleanup());

test('library size is computed in the background and cached, never blocking', async () => {
  const dir = path.join(process.env.SONGARR_MUSIC_DIR, 'A', 'B (2000)');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 - x.flac'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.alloc(5 * 1024 * 1024));
  assert.equal(librarySize(process.env.SONGARR_MUSIC_DIR), 'Calculating…');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(librarySize(process.env.SONGARR_MUSIC_DIR), '2.0 MB', 'FLAC counted, cover art not');
});
