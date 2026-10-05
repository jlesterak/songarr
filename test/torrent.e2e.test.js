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
    seedAfterImport: true,
    seedRatioLimit: 0,
    seedTimeLimitHours: 0,
    importMode: 'hardlink',
    indexerType: indexer,
    prowlarrUrl: `${base}/${indexer}`,
    torrentClient: client,
    torrentClientUrl: clientUrl[client](),
    ...settings
  });
  await db.addTrack({ id, title, artists: [artist], album: 'Test Album', duration: 200 });
  return runUntilSettled(id);
}

test('Prowlarr + qBittorrent: resolves the real hash, imports and tags an MP3, removes the torrent when not seeding', async () => {
  const t = await grab({
    id: 'qb1', artist: 'M83', title: 'Midnight City', client: 'qbittorrent',
    settings: { seedAfterImport: false }
  });
  assert.equal(t.status, 'imported', t.error);
  // qBittorrent's add call returns no hash; it must be looked up, not stored as `true`
  assert.match(t.torrentHash, /^[0-9a-f]{40}$/);
  assert.equal(path.extname(t.filePath), '.mp3');
  assert.equal(fs.readFileSync(t.filePath).subarray(0, 3).toString(), 'ID3');

  const res = await fetch(`${base}/qbittorrent/api/v2/torrents/info?hashes=${t.torrentHash}`);
  assert.deepEqual(await res.json(), [], 'torrent removed from client after import');
  assert.equal(t.seeding, false);
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

test('a stalled torrent is dropped for the next candidate; after the attempt limit, YouTube', async () => {
  await grab({
    id: 'st1', artist: 'Nobody', title: 'Dead Torrent', client: 'qbittorrent',
    settings: { stallTimeoutMinutes: 0.0001, maxTorrentAttempts: 2 }
  });
  const t = await runUntilSettled('st1', 10);
  // Both dead releases tried in turn, then the YouTube fallback (which fails offline).
  assert.deepEqual(t.triedTorrents, ['Nobody - Dead Torrent [MP3 320kbps] dead-a', 'Nobody - Dead Torrent [MP3 320kbps] dead-b']);
  assert.equal(t.status, 'failed');
  const res = await fetch(`${base}/qbittorrent/api/v2/torrents/info?tag=songarr-st1`);
  assert.deepEqual(await res.json(), [], 'stalled torrents removed from the client');
  await db.updateSettings({ stallTimeoutMinutes: 30, maxTorrentAttempts: 3 });
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

// Where the mocks leave a finished download's main file
function downloadedFile(artist, title, format) {
  const name = `${artist} - ${title}`;
  return path.join(process.env.SONGARR_DATA_DIR, 'temp', 'mock_downloads', name, `${name}.${format}`);
}

async function qbInfo(hash) {
  const res = await fetch(`${base}/qbittorrent/api/v2/torrents/info?hash=${hash}&hashes=${hash}`);
  return res.json();
}

async function cycles(n) {
  for (let i = 0; i < n; i++) await worker.processQueue();
}

const flacRule = artist => ({ qualityRules: [{ type: 'artist', name: artist, format: 'flac', quality: 'lossless' }] });

test('seeding by default: FLAC is hardlinked into the library and the torrent stays in the client', async () => {
  const t = await grab({ id: 'seed1', artist: 'Boards of Canada', title: 'Roygbiv', client: 'qbittorrent', settings: flacRule('boards of canada') });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.seeding, true);
  const src = downloadedFile('Boards of Canada', 'Roygbiv', 'flac');
  assert.equal(fs.statSync(t.filePath).ino, fs.statSync(src).ino, 'library file is a hardlink of the download');
  await cycles(3);
  assert.equal((await qbInfo(t.torrentHash)).length, 1, 'still seeding with no limits set');
  assert.equal(db.getTrack('seed1').seeding, true);
});

test('seeding MP3s are copied, so ID3 tagging never touches the data being seeded', async () => {
  const t = await grab({ id: 'seed2', artist: 'Bonobo', title: 'Kerala', client: 'qbittorrent' });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.seeding, true);
  const src = downloadedFile('Bonobo', 'Kerala', 'mp3');
  assert.notEqual(fs.statSync(t.filePath).ino, fs.statSync(src).ino);
  assert.equal(fs.readFileSync(t.filePath).subarray(0, 3).toString(), 'ID3');
  assert.equal(fs.readFileSync(src, 'utf-8'), 'MOCK AUDIO DATA CONTENT', 'seeded file untouched');
});

test('ratio limit: torrent and its download files are removed once reached; the hardlinked library file survives', async () => {
  const t = await grab({
    id: 'seed3', artist: 'Tycho', title: 'Awake', client: 'qbittorrent',
    settings: { ...flacRule('tycho'), seedRatioLimit: 1 }
  });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.seeding, true);
  const src = downloadedFile('Tycho', 'Awake', 'flac');
  assert.ok(fs.existsSync(src));

  await cycles(4);
  assert.equal(db.getTrack('seed3').seeding, false);
  assert.deepEqual(await qbInfo(t.torrentHash), [], 'torrent removed');
  assert.ok(!fs.existsSync(src), 'download files deleted');
  assert.equal(fs.readFileSync(t.filePath, 'utf-8'), 'MOCK AUDIO DATA CONTENT', 'library copy intact');
});

test('seed time limit works with Transmission', async () => {
  const t = await grab({
    id: 'seed4', artist: 'Lemon Jelly', title: 'Nice Weather', client: 'transmission',
    settings: { ...flacRule('lemon jelly'), seedTimeLimitHours: 2 }
  });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.seeding, true);
  await cycles(4);
  assert.equal(db.getTrack('seed4').seeding, false);
  assert.ok(fs.existsSync(t.filePath));
});

test('copy import mode never hardlinks', async () => {
  const t = await grab({
    id: 'seed5', artist: 'Royksopp', title: 'Eple', client: 'deluge',
    settings: { ...flacRule('royksopp'), importMode: 'copy' }
  });
  assert.equal(t.status, 'imported', t.error);
  assert.notEqual(fs.statSync(t.filePath).ino, fs.statSync(downloadedFile('Royksopp', 'Eple', 'flac')).ino);
});

test('SABnzbd jobs never count as seeding', async () => {
  const t = await grab({ id: 'seed6', artist: 'Zero 7', title: 'Destiny', client: 'sabnzbd' });
  assert.equal(t.status, 'imported', t.error);
  assert.equal(t.seeding, false);
});
