import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { TEMP_DIR } from './config.js';
import { torrentInfoHash } from './utils.js';

// Fake indexers and download clients, mounted at /api/v1/mock when
// SONGARR_MOCKS=1. They follow the real APIs closely enough to exercise the
// torrent path end to end: each status poll advances a download by 50%,
// finished downloads leave real files under TEMP_DIR/mock_downloads, and each
// poll of a finished torrent adds 0.5 to its ratio and an hour of seed time.

const router = express.Router();
const DOWNLOAD_DIR = path.join(TEMP_DIR, 'mock_downloads');

// Mock torrents state
let mockTorrents = [];
let nextId = 1;

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}${req.baseUrl}`;
}

// The release name and format ride along in the download URL as query params.
function parseDownloadUrl(url) {
  const params = new URLSearchParams(String(url).split('?')[1] || '');
  return {
    name: params.get('name') || params.get('dn') || 'mock_torrent',
    format: params.get('format') || 'mp3',
    dead: params.get('dead') === '1'
  };
}

// A minimal real .torrent; the mock clients read the release back out of its
// comment, the way they read it from a magnet's query string.
function mockTorrentFile(name, format) {
  const b = str => `${Buffer.byteLength(str)}:${str}`;
  const comment = `magnet:?dn=${encodeURIComponent(name)}&format=${format}`;
  const info = `d6:lengthi10000000e${b('name')}${b(name)}12:piece lengthi262144e6:pieces20:${'x'.repeat(20)}e`;
  return Buffer.from(`d${b('comment')}${b(comment)}4:info${info}e`);
}

// What a mock client was handed: { magnet } or { file } (a .torrent Buffer).
function addMockTorrent(client, { magnet, file }, extra = {}) {
  let source = magnet || '';
  let hash = crypto.randomBytes(20).toString('hex');
  if (file) {
    const text = file.toString('latin1');
    const m = /7:comment(\d+):/.exec(text);
    source = m ? text.substr(m.index + m[0].length, Number(m[1])) : '';
    hash = torrentInfoHash(file) || hash;
  }
  const { name, format, dead } = parseDownloadUrl(source);
  const torrent = {
    id: nextId++,
    hash,
    name,
    trackTitle: name,
    format,
    dead,
    progress: 0,
    ratio: 0,
    seedingTime: 0,
    client,
    tags: [],
    ...extra
  };
  mockTorrents.push(torrent);
  return torrent;
}

function torrentDir(torrent) {
  return path.join(DOWNLOAD_DIR, torrent.name.replace(/[\\/:*?"<>|]/g, '_'));
}

// Drop torrents from the mock state, deleting their files if asked to
async function removeMockTorrents(match, deleteFiles) {
  const removed = mockTorrents.filter(match);
  mockTorrents = mockTorrents.filter(t => !match(t));
  if (deleteFiles) {
    for (const t of removed) await fs.rm(torrentDir(t), { recursive: true, force: true });
  }
}

// Helper to create dummy audio files in the mock download directory
async function createMockAudioFiles(torrent) {
  const cleanTitle = torrent.trackTitle.replace(/[\\/:*?"<>|]/g, '_');

  const downloadDir = torrentDir(torrent);
  await fs.mkdir(downloadDir, { recursive: true });

  // The wanted track, plus a second file so album mode has something to copy
  await fs.writeFile(path.join(downloadDir, `${cleanTitle}.${torrent.format}`), 'MOCK AUDIO DATA CONTENT', 'utf-8');
  await fs.writeFile(path.join(downloadDir, `02 - Extra Track.${torrent.format}`), 'MOCK EXTRA AUDIO DATA', 'utf-8');
}

async function advance(torrent) {
  if (torrent.dead) return;
  if (torrent.progress >= 100) {
    torrent.ratio += 0.5;
    torrent.seedingTime += 3600;
    return;
  }
  torrent.progress = Math.min(100, torrent.progress + 50);
  if (torrent.progress === 100) {
    await createMockAudioFiles(torrent);
  }
}

function releases(req, query) {
  const cleanQuery = String(query || '').replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'Mock Track';
  const link = (format, dead) => `${baseUrl(req)}/download/torrent?name=${encodeURIComponent(cleanQuery)}&format=${format}${dead ? '&dead=1' : ''}`;
  // Queries naming "Dead Torrent" get two well-"seeded" releases that never download.
  const deadOnes = /dead torrent/i.test(cleanQuery) ? [
    { title: `${cleanQuery} [MP3 320kbps] dead-a`, link: link('mp3', true), size: 10000000, seeders: 900, peers: 1 },
    { title: `${cleanQuery} [MP3 320kbps] dead-b`, link: link('mp3', true), size: 10000000, seeders: 800, peers: 1 }
  ] : [];
  return [
    ...deadOnes,
    { title: `${cleanQuery} [FLAC] [Lossless]`, link: link('flac'), size: 35000000, seeders: 42, peers: 5 },
    { title: `${cleanQuery} [MP3 320kbps]`, link: link('mp3'), size: 10000000, seeders: 15, peers: 1 }
  ];
}

// 1. Mock Prowlarr Search
router.get('/prowlarr/api/v1/search', (req, res) => {
  res.json(releases(req, req.query.query).map((r, i) => ({
    title: r.title,
    downloadUrl: r.link,
    guid: `mock_guid_${i}_${Date.now()}`,
    size: r.size,
    seeders: r.seeders,
    peers: r.peers,
    indexer: 'MockTracker'
  })));
});

// 2. Mock Jackett Search
router.get('/jackett/api/v2.0/indexers/all/results', (req, res) => {
  res.json({
    Results: releases(req, req.query.Query).map(r => ({
      Title: r.title,
      Link: r.link,
      Size: r.size,
      Seeders: r.seeders,
      Peers: r.peers
    }))
  });
});

// 3. Mock torrent download URL (clients fetch this; the mocks never do)
// Like Prowlarr: a .torrent file for some releases, a redirect to a magnet
// for magnet-only ones.
router.get('/download/torrent', (req, res) => {
  const { name, format, dead } = parseDownloadUrl(req.originalUrl);
  if (format === 'flac') {
    return res.type('application/x-bittorrent').send(mockTorrentFile(name, format));
  }
  res.redirect(302, `magnet:?dn=${encodeURIComponent(name)}&format=${format}${dead ? '&dead=1' : ''}`);
});

// 4. Mock qBittorrent
router.post('/qbittorrent/api/v2/auth/login', (req, res) => {
  res.header('Set-Cookie', 'SID=mock_sid_cookie; Path=/;');
  res.send('Ok.');
});

router.post('/qbittorrent/api/v2/torrents/add', express.raw({ type: 'multipart/form-data', limit: '5mb' }), async (req, res) => {
  const form = await new Response(req.body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
  const tags = String(form.get('tags') || '').split(',').map(t => t.trim()).filter(Boolean);
  const upload = form.get('torrents');
  addMockTorrent('qbittorrent', upload
    ? { file: Buffer.from(await upload.arrayBuffer()) }
    : { magnet: String(form.get('urls') || '') }, { tags });
  // Like the real client: no hash in the response.
  res.send('Ok.');
});

router.get('/qbittorrent/api/v2/torrents/info', async (req, res) => {
  const hashes = req.query.hashes ? String(req.query.hashes).split('|') : null;
  const tag = req.query.tag;
  const list = mockTorrents.filter(t => t.client === 'qbittorrent'
    && (!hashes || hashes.includes(t.hash))
    && (tag === undefined || t.tags.includes(tag)));
  // Only status polls by hash advance progress, not tag lookups after add.
  if (hashes) {
    for (const t of list) await advance(t);
  }
  res.json(list.map(t => ({
    hash: t.hash,
    name: t.name,
    progress: t.progress / 100,
    state: t.progress === 100 ? 'uploading' : 'downloading',
    save_path: DOWNLOAD_DIR,
    tags: t.tags.join(', '),
    ratio: t.ratio,
    seeding_time: t.seedingTime
  })));
});

router.get('/qbittorrent/api/v2/torrents/files', (req, res) => {
  const t = mockTorrents.find(x => x.hash === req.query.hash);
  if (!t) return res.status(404).send('Not Found');
  res.json([{ name: `${t.name}/${t.trackTitle}.${t.format}` }]);
});

router.post('/qbittorrent/api/v2/torrents/delete', express.urlencoded({ extended: true }), async (req, res) => {
  const hashes = String(req.body.hashes || '').split('|');
  await removeMockTorrents(t => hashes.includes(t.hash), req.body.deleteFiles === 'true');
  res.send('Ok.');
});

// 5. Mock Deluge
router.post('/deluge/json', async (req, res) => {
  const { method, params, id } = req.body;

  if (method === 'auth.login') {
    res.header('Set-Cookie', '_session_id=mock_deluge_cookie; Path=/;');
    return res.json({ result: true, error: null, id });
  }

  if (method === 'core.add_torrent_magnet' || method === 'core.add_torrent_file') {
    const torrent = addMockTorrent('deluge', method === 'core.add_torrent_magnet'
      ? { magnet: params[0] || '' }
      : { file: Buffer.from(params[1] || '', 'base64') });
    return res.json({ result: torrent.hash, error: null, id });
  }

  if (method === 'core.get_torrent_status') {
    const torrent = mockTorrents.find(t => t.hash === params[0]);
    if (!torrent) {
      // Real Deluge returns an empty dict for unknown hashes
      return res.json({ result: {}, error: null, id });
    }
    await advance(torrent);
    return res.json({
      result: {
        progress: torrent.progress,
        state: torrent.progress === 100 ? 'Seeding' : 'Downloading',
        save_path: DOWNLOAD_DIR,
        name: torrent.name,
        ratio: torrent.ratio,
        seeding_time: torrent.seedingTime,
        files: [
          { path: `${torrent.name}/${torrent.trackTitle}.${torrent.format}`, size: 10000000 }
        ]
      },
      error: null,
      id
    });
  }

  if (method === 'core.remove_torrent') {
    await removeMockTorrents(t => t.hash === params[0], params[1] === true);
    return res.json({ result: true, error: null, id });
  }

  res.json({ result: null, error: { message: 'Method not supported' }, id });
});

// 6. Mock Transmission
router.post('/transmission/transmission/rpc', async (req, res) => {
  if (!req.headers['x-transmission-session-id']) {
    res.status(409).header('X-Transmission-Session-Id', 'mock_transmission_session_id').send('Session ID required');
    return;
  }

  const { method, arguments: args } = req.body;

  if (method === 'torrent-add') {
    const t = addMockTorrent('transmission', args.metainfo
      ? { file: Buffer.from(args.metainfo, 'base64') }
      : { magnet: args.filename || '' });
    return res.json({
      result: 'success',
      arguments: { 'torrent-added': { id: t.id, name: t.name, hashString: t.hash } }
    });
  }

  if (method === 'torrent-get') {
    const ids = args.ids;
    const list = mockTorrents.filter(t => t.client === 'transmission'
      && (!ids || ids.includes(t.id) || ids.includes(t.hash)));
    for (const t of list) await advance(t);
    return res.json({
      result: 'success',
      arguments: {
        torrents: list.map(t => ({
          id: t.id,
          hashString: t.hash,
          name: t.name,
          percentDone: t.progress / 100,
          status: t.progress === 100 ? 6 : 4,
          downloadDir: DOWNLOAD_DIR,
          uploadRatio: t.progress === 100 ? t.ratio : -1,
          secondsSeeding: t.seedingTime,
          files: [{ name: `${t.name}/${t.trackTitle}.${t.format}`, length: 10000000 }]
        }))
      }
    });
  }

  if (method === 'torrent-remove') {
    const ids = args.ids || [];
    await removeMockTorrents(t => ids.includes(t.id) || ids.includes(t.hash), args['delete-local-data'] === true);
    return res.json({ result: 'success', arguments: {} });
  }

  res.json({ result: 'method not supported' });
});

// 7. Mock SABnzbd (finished jobs move from the queue to history, as in the real one)
router.get('/sabnzbd/api', async (req, res) => {
  const { mode, name, value } = req.query;
  const sab = () => mockTorrents.filter(t => t.client === 'sabnzbd');

  if (mode === 'addurl') {
    const t = addMockTorrent('sabnzbd', { magnet: name || '' });
    t.hash = 'SABnzbd_nzo_' + t.hash.slice(0, 8);
    return res.json({ status: true, nzo_ids: [t.hash] });
  }

  if ((mode === 'queue' || mode === 'history') && name === 'delete') {
    await removeMockTorrents(t => t.hash === value, req.query.del_files === '1');
    return res.json({ status: true });
  }

  if (mode === 'queue') {
    const active = sab().filter(t => t.progress < 100);
    for (const t of active) await advance(t);
    return res.json({
      queue: {
        slots: active.filter(t => t.progress < 100).map(t => ({
          nzo_id: t.hash,
          filename: t.name,
          status: 'Downloading',
          percentage: String(t.progress),
          size: '30 MB'
        }))
      }
    });
  }

  if (mode === 'history') {
    return res.json({
      history: {
        slots: sab().filter(t => t.progress === 100).map(t => ({
          nzo_id: t.hash,
          name: t.name,
          status: 'Completed',
          storage: torrentDir(t)
        }))
      }
    });
  }

  res.json({ error: 'Mode not supported' });
});

export default router;
