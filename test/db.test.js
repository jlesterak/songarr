import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const dataDir = process.env.SONGARR_DATA_DIR;

// A database left behind mid-download, to check crash recovery on startup.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
  tracks: [
    { id: 'a', title: 'Stuck', artists: ['X'], status: 'downloading' },
    { id: 'b', title: 'Done', artists: ['X'], status: 'imported' },
    { id: 'h1', title: 'In client', artists: ['X'], status: 'snatched', torrentHash: 'abc' },
    { id: 'h2', title: 'Import cut off', artists: ['X'], status: 'downloaded', torrentHash: 'def' }
  ],
  playlists: [],
  settings: { audioFormat: 'm4a' }
}));

const db = await import('../server/db.js');
const { getTrackQualityRule, albumFolder } = await import('../server/worker.js');
await db.init();
after(() => env.cleanup());

test('init keeps stored settings and fills new defaults', () => {
  const s = db.getSettings();
  assert.equal(s.audioFormat, 'm4a');
  assert.equal(s.downloadMethod, 'direct');
  assert.equal(s.downloadPathRemote, '');
  assert.equal(s.libraryPath, process.env.SONGARR_MUSIC_DIR);
  assert.ok(fs.existsSync(process.env.SONGARR_MUSIC_DIR), 'library dir created');
});

test('init resets interrupted downloads to wanted, leaves imported alone', () => {
  assert.equal(db.getTrack('a').status, 'wanted');
  assert.equal(db.getTrack('b').status, 'imported');
});

test('init keeps downloads the client already has, and re-polls an interrupted import', () => {
  assert.equal(db.getTrack('h1').status, 'snatched');
  assert.equal(db.getTrack('h1').torrentHash, 'abc');
  assert.equal(db.getTrack('h2').status, 'downloading');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf-8'));
  assert.equal(onDisk.tracks.find(t => t.id === 'a').status, 'wanted');
});

test('re-adding a failed track requeues it; re-adding a live one is a no-op', async () => {
  await db.addTrack({ id: 'c', title: 'T', artist: 'Y' });
  await db.updateTrack('c', { status: 'failed', error: 'boom' });
  const again = await db.addTrack({ id: 'c', title: 'T', artist: 'Y' });
  assert.equal(again.status, 'wanted');
  assert.equal(again.error, null);
  assert.deepEqual(again.artists, ['Y']);
  assert.equal(db.getTracks().filter(t => t.id === 'c').length, 1);
});

test('a posted search result cannot set its own status', async () => {
  const t = await db.addTrack({ id: 'd', title: 'T', artist: 'Y', status: 'none', error: 'x', filePath: '/etc/passwd' });
  assert.equal(t.status, 'wanted');
  assert.equal(t.error, null);
  assert.equal(t.filePath, '');
});

test('album folder carries the release year when known', () => {
  assert.equal(albumFolder({ album: 'Currents', releaseDate: '2015-07-17' }), 'Currents (2015)');
  assert.equal(albumFolder({ album: 'A/B', releaseDate: '' }), 'A_B');
  assert.equal(albumFolder({ album: 'X' }), 'X');
});

test('quality rules: playlist rule beats artist rule, names match case-insensitively', async () => {
  const settings = {
    qualityRules: [
      { type: 'artist', name: 'm83', format: 'mp3', quality: '320k' },
      { type: 'playlist', name: 'lossless', format: 'flac', quality: 'lossless' }
    ]
  };
  const track = await db.addTrack({ id: 'r1', title: 'Wait', artists: ['M83'] });
  const other = await db.addTrack({ id: 'r2', title: 'Song', artists: ['Nobody'] });

  assert.equal(getTrackQualityRule(track, settings).format, 'mp3');
  assert.equal(getTrackQualityRule(other, settings), null);

  const pl = await db.createPlaylist('Lossless');
  await db.addTrackToPlaylist(pl.id, 'r1');
  assert.equal(getTrackQualityRule(track, settings).format, 'flac');
});
