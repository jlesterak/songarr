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

test('swapping to another match re-points linked playlists and remembers the rejected id', async () => {
  const sync = await import('../server/sync.js');
  await db.addTrack({ id: '111', title: 'Baby Got Back (Techno Remix)', artists: ['Sir Mix-a-Lot'] });
  const pl = await db.createPlaylist('Linked', '', { sourceId: 'spotify:x' });
  await db.updatePlaylist(pl.id, {
    trackIds: ['111'],
    sourceTracks: [{ key: 'k', artist: 'Sir Mix-a-Lot', title: 'Baby Got Back', trackId: '111' }]
  });

  const added = await sync.replaceMatch('111', { id: 'mb:right', title: 'Baby Got Back', artists: ['Sir Mix-a-Lot'], album: 'Mack Daddy' });
  assert.equal(added.id, 'mb:right');
  assert.deepEqual(added.rejectedIds, ['111']);
  assert.equal(db.getTrack('111'), null);
  const after = db.getPlaylists().find(p => p.id === pl.id);
  assert.deepEqual(after.trackIds, ['mb:right']);
  assert.deepEqual(after.sourceTracks[0], { key: 'k', artist: 'Sir Mix-a-Lot', title: 'Baby Got Back', trackId: 'mb:right', manual: true });
});
