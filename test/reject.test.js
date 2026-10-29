import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const worker = await import('../server/worker.js');
await db.init();
after(() => env.cleanup());

test('rejecting a wrong version deletes the file, blocks its source and re-queues', async () => {
  const dir = path.join(process.env.SONGARR_MUSIC_DIR, 'Sir Mix-a-Lot', 'Mack Daddy');
  const file = path.join(dir, '01 - Baby Got Back.mp3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'techno remix');
  await db.addTrack({ id: 't1', title: 'Baby Got Back', artists: ['Sir Mix-a-Lot'] });
  await db.updateTrack('t1', { status: 'imported', source: 'torrent', torrentName: 'Baby Got Back (Techno Remix)', filePath: file });
  const pl = await db.createPlaylist('Rejects');
  await db.addTrackToPlaylist(pl.id, 't1');

  const track = await worker.rejectTrack('t1');
  assert.equal(track.status, 'wanted');
  assert.equal(track.filePath, '');
  assert.deepEqual(track.blocked, ['torrent:Baby Got Back (Techno Remix)']);
  assert.ok(!fs.existsSync(dir), 'file and its now-empty album folder are gone');
  assert.doesNotMatch(fs.readFileSync(worker.m3uPath('Rejects'), 'utf-8'), /Baby Got Back/);
});
