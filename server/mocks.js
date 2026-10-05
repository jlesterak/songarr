import express from 'express';
import path from 'path';
import fs from 'fs/promises';

const router = express.Router();

// Mock torrents state
let mockTorrents = [];
let nextId = 1;

// Helper to create dummy audio files in temp directory
async function createMockAudioFiles(torrentName, trackTitle, format) {
  const cleanName = torrentName.replace(/[\\/:*?"<>|]/g, '_');
  const cleanTitle = trackTitle.replace(/[\\/:*?"<>|]/g, '_');
  
  const downloadDir = path.resolve('temp', 'mock_downloads', cleanName);
  await fs.mkdir(downloadDir, { recursive: true });
  
  // Create the main track file
  const mainFile = path.join(downloadDir, `${cleanTitle}.${format}`);
  await fs.writeFile(mainFile, 'MOCK AUDIO DATA CONTENT', 'utf-8');
  
  // If in album mode, create an extra dummy track to simulate an album
  const extraFile = path.join(downloadDir, `02 - Extra Track.${format}`);
  await fs.writeFile(extraFile, 'MOCK EXTRA AUDIO DATA', 'utf-8');
  
  console.log(`[Mock Server] Created mock files in ${downloadDir}`);
}

// Automatically increment progress for active downloads
setInterval(async () => {
  for (const t of mockTorrents) {
    if (t.progress < 100) {
      t.progress += 25;
      if (t.progress >= 100) {
        t.progress = 100;
        t.status = 'seeding'; // finished downloading
        try {
          await createMockAudioFiles(t.name, t.trackTitle, t.format);
        } catch (e) {
          console.error('[Mock Server] Failed to create mock download files:', e);
        }
      }
    }
  }
}, 3000);

// 1. Mock Prowlarr Search
router.get('/prowlarr/api/v1/search', (req, res) => {
  const query = req.query.query || '';
  
  // Clean query for filename/title
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'Mock Track';
  
  res.json([
    {
      title: `${cleanQuery} [FLAC] [Lossless]`,
      downloadUrl: `http://localhost:3001/api/v1/mock/download/torrent?name=${encodeURIComponent(cleanQuery)}&format=flac`,
      guid: `mock_guid_flac_${Date.now()}`,
      size: 35000000,
      seeders: 42,
      peers: 5,
      indexer: "MockTracker"
    },
    {
      title: `${cleanQuery} [MP3 320kbps]`,
      downloadUrl: `http://localhost:3001/api/v1/mock/download/torrent?name=${encodeURIComponent(cleanQuery)}&format=mp3`,
      guid: `mock_guid_mp3_${Date.now()}`,
      size: 10000000,
      seeders: 15,
      peers: 1,
      indexer: "MockTracker"
    }
  ]);
});

// 2. Mock Jackett Search
router.get('/jackett/api/v2.0/indexers/all/results', (req, res) => {
  const query = req.query.Query || '';
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'Mock Track';
  
  res.json({
    Results: [
      {
        Title: `${cleanQuery} [FLAC] [Lossless]`,
        Link: `http://localhost:3001/api/v1/mock/download/torrent?name=${encodeURIComponent(cleanQuery)}&format=flac`,
        Size: 35000000,
        Seeders: 42,
        Peers: 5
      },
      {
        Title: `${cleanQuery} [MP3 320kbps]`,
        Link: `http://localhost:3001/api/v1/mock/download/torrent?name=${encodeURIComponent(cleanQuery)}&format=mp3`,
        Size: 10000000,
        Seeders: 15,
        Peers: 1
      }
    ]
  });
});

// 3. Mock Torrent file/magnet download URL endpoint
router.get('/download/torrent', (req, res) => {
  const name = req.query.name || 'mock_torrent';
  const format = req.query.format || 'mp3';
  // Send back a plain text string representing a magnet link containing parameters
  res.send(`magnet:?xt=urn:btih:mockhash${Date.now()}&dn=${encodeURIComponent(name)}&tr=udp%3a%2f%2ftracker.mock.com&format=${format}`);
});

// 4. Mock qBittorrent
router.post('/qbittorrent/api/v2/auth/login', (req, res) => {
  res.header('Set-Cookie', 'SID=mock_sid_cookie; Path=/;');
  res.send('Ok.');
});

router.post('/qbittorrent/api/v2/torrents/add', express.urlencoded({ extended: true }), (req, res) => {
  const urls = req.body.urls || '';
  const dnMatch = urls.match(/dn=([^&]+)/);
  const formatMatch = urls.match(/format=([^&]+)/);
  const name = dnMatch ? decodeURIComponent(dnMatch[1]) : 'mock_torrent';
  const format = formatMatch ? formatMatch[1] : 'mp3';
  
  const hash = 'qb_' + Math.random().toString(36).substr(2, 9);
  
  mockTorrents.push({
    id: nextId++,
    hash,
    name,
    trackTitle: name,
    format,
    progress: 0,
    status: 'downloading',
    client: 'qbittorrent'
  });
  
  res.send('Ok.');
});

router.get('/qbittorrent/api/v2/torrents/info', (req, res) => {
  const list = mockTorrents.filter(t => t.client === 'qbittorrent').map(t => ({
    hash: t.hash,
    name: t.name,
    progress: t.progress / 100,
    state: t.progress === 100 ? 'uploading' : 'downloading',
    save_path: path.resolve('temp/mock_downloads')
  }));
  res.json(list);
});

router.post('/qbittorrent/api/v2/torrents/delete', express.urlencoded({ extended: true }), (req, res) => {
  const hashes = req.body.hashes || '';
  mockTorrents = mockTorrents.filter(t => t.hash !== hashes);
  res.send('Ok.');
});

// 5. Mock Deluge
router.post('/deluge/json', (req, res) => {
  const { method, params, id } = req.body;
  
  if (method === 'auth.login') {
    res.header('Set-Cookie', 'cookie_uuid=mock_deluge_cookie; Path=/;');
    return res.json({ result: true, error: null, id });
  }
  
  if (method === 'core.add_torrent_url') {
    const url = params[0] || '';
    const dnMatch = url.match(/dn=([^&]+)/);
    const formatMatch = url.match(/format=([^&]+)/);
    const name = dnMatch ? decodeURIComponent(dnMatch[1]) : 'mock_torrent';
    const format = formatMatch ? formatMatch[1] : 'mp3';
    const hash = 'deluge_' + Math.random().toString(36).substr(2, 9);
    
    mockTorrents.push({
      id: nextId++,
      hash,
      name,
      trackTitle: name,
      format,
      progress: 0,
      status: 'Downloading',
      client: 'deluge'
    });
    
    return res.json({ result: hash, error: null, id });
  }
  
  if (method === 'core.get_torrent_status') {
    const hash = params[0];
    const torrent = mockTorrents.find(t => t.hash === hash);
    if (!torrent) {
      return res.json({ result: null, error: { message: "Torrent not found" }, id });
    }
    
    return res.json({
      result: {
        progress: torrent.progress,
        state: torrent.progress === 100 ? 'Seeding' : 'Downloading',
        save_path: path.resolve('temp/mock_downloads'),
        files: [
          { path: `${torrent.name}/${torrent.trackTitle}.${torrent.format}`, size: 10000000 }
        ]
      },
      error: null,
      id
    });
  }
  
  if (method === 'core.remove_torrent') {
    const hash = params[0];
    mockTorrents = mockTorrents.filter(t => t.hash !== hash);
    return res.json({ result: true, error: null, id });
  }
  
  res.json({ result: null, error: { message: "Method not supported" }, id });
});

// 6. Mock Transmission
router.post('/transmission/transmission/rpc', (req, res) => {
  const sessionId = req.headers['x-transmission-session-id'];
  if (!sessionId) {
    res.status(409).header('X-Transmission-Session-Id', 'mock_transmission_session_id').send('Session ID required');
    return;
  }
  
  const { method, arguments: args } = req.body;
  
  if (method === 'torrent-add') {
    const url = args.filename || '';
    const dnMatch = url.match(/dn=([^&]+)/);
    const formatMatch = url.match(/format=([^&]+)/);
    const name = dnMatch ? decodeURIComponent(dnMatch[1]) : 'mock_torrent';
    const format = formatMatch ? formatMatch[1] : 'mp3';
    const hash = 'trans_' + Math.random().toString(36).substr(2, 9);
    const id = nextId++;
    
    mockTorrents.push({
      id,
      hash,
      name,
      trackTitle: name,
      format,
      progress: 0,
      status: 'downloading',
      client: 'transmission'
    });
    
    return res.json({
      result: 'success',
      arguments: {
        'torrent-added': { id, name, hashString: hash }
      }
    });
  }
  
  if (method === 'torrent-get') {
    const list = mockTorrents.filter(t => t.client === 'transmission').map(t => ({
      id: t.id,
      hashString: t.hash,
      name: t.name,
      percentDone: t.progress / 100,
      status: t.progress === 100 ? 6 : 4,
      downloadDir: path.resolve('temp/mock_downloads'),
      files: [
        { name: `${t.name}/${t.trackTitle}.${t.format}`, length: 10000000 }
      ]
    }));
    return res.json({
      result: 'success',
      arguments: { torrents: list }
    });
  }
  
  if (method === 'torrent-remove') {
    const ids = args.ids || [];
    mockTorrents = mockTorrents.filter(t => !ids.includes(t.id) && !ids.includes(t.hash));
    return res.json({ result: 'success', arguments: {} });
  }
  
  res.json({ result: 'method not supported' });
});

// 7. Mock SABnzbd
router.get('/sabnzbd/api', (req, res) => {
  const mode = req.query.mode;
  
  if (mode === 'addurl') {
    const url = req.query.name || '';
    const dnMatch = url.match(/dn=([^&]+)/);
    const formatMatch = url.match(/format=([^&]+)/);
    const name = dnMatch ? decodeURIComponent(dnMatch[1]) : 'mock_torrent';
    const format = formatMatch ? formatMatch[1] : 'mp3';
    const hash = 'sab_' + Math.random().toString(36).substr(2, 9);
    
    mockTorrents.push({
      id: nextId++,
      hash,
      name,
      trackTitle: name,
      format,
      progress: 0,
      status: 'Downloading',
      client: 'sabnzbd'
    });
    
    return res.json({ status: true, nzo_ids: [hash] });
  }
  
  if (mode === 'queue') {
    const name = req.query.name;
    if (name === 'delete') {
      const value = req.query.value;
      mockTorrents = mockTorrents.filter(t => t.hash !== value);
      return res.json({ status: true });
    }
    
    const slots = mockTorrents.filter(t => t.client === 'sabnzbd').map(t => ({
      nzo_id: t.hash,
      filename: t.name,
      status: t.progress === 100 ? 'Completed' : 'Downloading',
      percentage: String(t.progress),
      size: '30 MB'
    }));
    
    return res.json({ queue: { slots } });
  }
  
  res.json({ error: "Mode not supported" });
});

export default router;
