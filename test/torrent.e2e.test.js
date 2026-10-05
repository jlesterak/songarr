import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { once } from 'events';
import { useTempEnv, quietConsole } from './helpers.js';

// Full torrent path: indexer search -> snatch -> progress polling -> import,
// against the mock indexers and clients served by the app itself.

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const worker = await import('../server/worker.js');
const { createApp } = await import('../server/app.js');

let server;
let base;

before(async () => {
  await db.init();
  const app = await createApp({ mocks: true });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/v1/mock`;
});

after(() => {
  server?.close();
  env.cleanup();
});

const clientUrl = {
  qbittorrent: () => `${base}/qbittorrent`,
  deluge: () => `${base}/deluge`,
  transmission: () => `${base}/transmission`,
  sabnzbd: () => base
};

async function runUntilSettled(id, maxCycles = 6) {
  for (let i = 0; i < maxCycles; i++) {
    await worker.processQueue();
    const t = db.getTrack(id);
    if (['imported', 'failed'].includes(t.status)) return t;
  }
  return db.getTrack(id);
}

async function grab({ id, artist, title, indexer = 'prowlarr', client, settings = {} }) {
  await db.updateSettings({
    autoDownload: false,
    downloadMethod: 'torrent',
    albumDownloadMode: 'single',
    audioFormat: 'mp3',
    qualityRules: [],
    indexerType: indexer,
    prowlarrUrl: `${base}/${indexer}`,
    torrentClient: client,
    torrentClientUrl: clientUrl[client](),
    ...settings
  });
  await db.addTrack({ id, title, artists: [artist], album: 'Test Album', duration: 200 });
  return runUntilSettled(id);
}

test('Prowlarr + qBittorrent: resolves the real hash, imports and tags an MP3, removes the torrent', async () => {
  const t = await grab({ id: 'qb1', artist: 'M83', title: 'Midnight City', client: 'qbittorrent' });
  assert.equal(t.status, 'imported', t.error);
  // qBittorrent's add call returns no hash; it must be looked up, not stored as `true`
  assert.match(t.torrentHash, /^[0-9a-f]{40}$/);
  assert.equal(path.extname(t.filePath), '.mp3');
  assert.equal(fs.readFileSync(t.filePath).subarray(0, 3).toString(), 'ID3');

  const res = await fetch(`${base}/qbittorrent/api/v2/torrents/info?hashes=${t.torrentHash}`);
  assert.deepEqual(await res.json(), [], 'torrent removed from client after import');
});

test('Jackett + Deluge: artist quality rule picks FLAC and the file keeps its .flac container untouched', async () => {
  const t = await grab({
    id: 'dl1', artist: 'Daft Punk', title: 'Veridis Quo', indexer: 'jackett', client: 'deluge',
    settings: { qualityRules: [{ type: 'artist', name: 'daft punk', format: 'flac', quality: 'lossless' }] }
  });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.targetFormat, 'flac');
  assert.equal(t.format, 'flac');
  assert.equal(path.extname(t.filePath), '.flac');
  assert.equal(fs.readFileSync(t.filePath, 'utf-8'), 'MOCK AUDIO DATA CONTENT', 'no ID3 header written into FLAC');
});

test('Prowlarr + Transmission imports', async () => {
  const t = await grab({ id: 'tr1', artist: 'Air', title: 'La Femme d Argent', client: 'transmission' });
  assert.equal(t.status, 'imported', t.error);
  assert.ok(fs.existsSync(t.filePath));
});

test('Prowlarr + SABnzbd imports from history', async () => {
  const t = await grab({ id: 'sab1', artist: 'Moby', title: 'Porcelain', client: 'sabnzbd' });
  assert.equal(t.status, 'imported', t.error);
  assert.ok(fs.existsSync(t.filePath));
});

test('album mode copies every file and points filePath at the requested track', async () => {
  const t = await grab({
    id: 'alb1', artist: 'Justice', title: 'Genesis', client: 'qbittorrent',
    settings: { albumDownloadMode: 'album' }
  });
  assert.equal(t.status, 'imported', t.error);
  assert.ok(fs.existsSync(t.filePath), `filePath exists: ${t.filePath}`);
  assert.match(path.basename(t.filePath), /^01 - Genesis\.mp3$/);
  assert.ok(fs.existsSync(path.join(path.dirname(t.filePath), '02 - Extra Track.mp3')));
});

test('indexer failure falls back to YouTube, and a failed YouTube download marks the track failed', async () => {
  await db.updateSettings({ prowlarrUrl: `${base}/nonexistent` });
  await db.addTrack({ id: 'fb1', title: 'Nothing', artists: ['Nobody'], album: 'X', duration: 100 });
  const t = await runUntilSettled('fb1');
  assert.equal(t.status, 'failed');
  assert.ok(t.error);
});

test('a download the client no longer knows about reads as missing, for every client', async () => {
  const { getDownloadClient } = await import('../server/utils.js');
  for (const client of Object.keys(clientUrl)) {
    const c = getDownloadClient({ torrentClient: client, torrentClientUrl: clientUrl[client]() });
    assert.equal(await c.getProgress('f'.repeat(40)), null, client);
  }
});
