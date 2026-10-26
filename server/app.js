import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import * as db from './db.js';
import * as utils from './utils.js';
import * as worker from './worker.js';
import * as sync from './sync.js';
import * as musicbrainz from './musicbrainz.js';
import { getAttention, inboxProblem } from './inbox.js';
import { isDeezerId } from './musicbrainz.js';
import { DIST_DIR } from './config.js';

// Builds the Express app. Callers must `await db.init()` first; starting the
// worker and listening are left to server/index.js (and to tests).
const AUDIO_EXT = /\.(mp3|m4a|flac|opus|ogg|wav|aac)$/i;
const SIZE_TTL_MS = 30 * 60 * 1000;
const sizeCache = { dir: null, text: 'Calculating…', at: 0, running: false };

async function dirAudioBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirAudioBytes(p);
    else if (e.isFile() && AUDIO_EXT.test(e.name)) {
      try { total += (await fs.stat(p)).size; } catch { /* vanished */ }
    }
  }
  return total;
}

function formatBytes(n) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// Cached library size; refreshes in the background when stale, never blocks.
export function librarySize(dir) {
  if (sizeCache.dir !== dir) Object.assign(sizeCache, { dir, text: 'Calculating…', at: 0 });
  if (!sizeCache.running && Date.now() - sizeCache.at > SIZE_TTL_MS) {
    sizeCache.running = true;
    dirAudioBytes(dir)
      .then(bytes => { if (sizeCache.dir === dir) Object.assign(sizeCache, { text: formatBytes(bytes), at: Date.now() }); })
      .finally(() => { sizeCache.running = false; });
  }
  return sizeCache.text;
}

// Secrets never leave the server: GET returns a mask, and a mask posted back
// means "keep the stored value".
export const SECRET_FIELDS = ['prowlarrApiKey', 'torrentClientPassword', 'navidromePassword', 'deemixArl'];
export const SECRET_MASK = '********';

export function maskSecrets(settings) {
  const out = { ...settings };
  for (const k of SECRET_FIELDS) if (out[k]) out[k] = SECRET_MASK;
  return out;
}

export function unmaskSecrets(body = {}) {
  const out = { ...body };
  for (const k of SECRET_FIELDS) if (out[k] === SECRET_MASK) delete out[k];
  return out;
}

export async function createApp({ mocks = process.env.SONGARR_MOCKS === '1' } = {}) {
  const app = express();

  // No CORS: the UI is same-origin (Vite proxies /api in dev), and an open
  // CORS policy would let any website in the user's browser drive this API.
  app.use(express.json());

  // Optional login: HTTP Basic auth when SONGARR_USERNAME/SONGARR_PASSWORD are
  // set. The healthcheck stays open.
  const user = process.env.SONGARR_USERNAME || '';
  const pass = process.env.SONGARR_PASSWORD || '';
  if (user && pass) {
    const expected = Buffer.from(`${user}:${pass}`);
    app.use((req, res, next) => {
      if (req.path === '/api/v1/health') return next();
      const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
      const given = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Songarr", charset="UTF-8"').status(401).send('Authentication required');
    });
  }

  // Fake Prowlarr/Jackett and download-client endpoints for development and tests.
  // Off unless SONGARR_MOCKS=1, so a real install never exposes them.
  if (mocks) {
    const { default: mockRouter } = await import('./mocks.js');
    app.use('/api/v1/mock', mockRouter);
    console.log('[Songarr Server] Mock indexer/client endpoints enabled at /api/v1/mock');
  }

  // === API ROUTES ===

  // 1. Search tracks
  app.get('/api/v1/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
  
    try {
      const results = await musicbrainz.withFallback(query, await utils.searchDeezer(query));
    
      // Map with existing db status
      const mappedResults = results.map(track => {
        const existing = db.getTrack(track.id);
        return {
          ...track,
          status: existing ? existing.status : 'none',
          error: existing ? existing.error : null
        };
      });
    
      res.json(mappedResults);
    } catch (err) {
      res.status(500).json({ error: 'Search failed', details: err.message });
    }
  });

  // 2. Track Details (for deep enrichment if needed)
  app.get('/api/v1/search/details/:id', async (req, res) => {
    try {
      const details = await utils.getDeezerTrackDetails(req.params.id);
      if (!details) return res.status(404).json({ error: 'Track details not found' });
      res.json(details);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch details', details: err.message });
    }
  });

  // 3. Queue / Monitor list
  app.get('/api/v1/tracks', (req, res) => {
    res.json(db.getTracks());
  });

  // 4. Request track (Add to queue)
  app.post('/api/v1/tracks', async (req, res) => {
    const trackData = req.body;
    if (!trackData.id || !trackData.title) {
      return res.status(400).json({ error: 'Missing track ID or title' });
    }
  
    try {
      // If we only have basic info, enrich it from Deezer details before adding
      let fullTrackData = { ...trackData };
      if (isDeezerId(trackData.id) && (!trackData.album || !trackData.albumArt || !trackData.duration || !trackData.releaseDate)) {
        console.log(`[API] Enriching track metadata for ${trackData.title}`);
        const details = await utils.getDeezerTrackDetails(trackData.id);
        if (details) {
          fullTrackData = { ...details, ...trackData };
        }
      }

      const track = await db.addTrack(fullTrackData);
    
      // Trigger download loop asynchronously
      worker.processQueue().catch(err => console.error('Error starting queue processor:', err));
    
      res.json(track);
    } catch (err) {
      res.status(500).json({ error: 'Failed to request track', details: err.message });
    }
  });

  // 5. Delete track from queue / DB
  app.delete('/api/v1/tracks/:id', async (req, res) => {
    try {
      const deleted = await db.deleteTrack(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Track not found' });
    
      // If the file exists, we don't delete it automatically, but we can if requested.
      // For now, just delete from database tracking.
      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete track', details: err.message });
    }
  });

  // 6. Clear completed tracks
  app.post('/api/v1/tracks/clear', async (req, res) => {
    try {
      // Take the queue's downloads out of the client too, or they'd be orphaned.
      const settings = db.getSettings();
      const active = db.getTracks().filter(t => t.status !== 'imported' && t.torrentHash);
      if (active.length) {
        const client = utils.getDownloadClient(settings);
        for (const t of active) {
          await client.removeTorrent(t.torrentHash, true).catch(err =>
            console.warn(`[API] Couldn't remove download for "${t.title}": ${err.message}`));
        }
      }
      await db.clearQueue();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to clear queue', details: err.message });
    }
  });

  // 7. Text batch import
  app.post('/api/v1/tracks/import-text', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });
  
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let addedCount = 0;
  
    // Process sequentially to not overload external APIs
    res.json({ success: true, message: `Started batch import of ${lines.length} lines. Processing...` });
  
    (async () => {
      for (const line of lines) {
        try {
          console.log(`[API Import] Searching for text track: "${line}"`);
          const searchResults = await utils.searchDeezer(line);
          if (searchResults.length > 0) {
            // Take the top matching result
            const topResult = searchResults[0];
            // Enrich details
            const details = await utils.getDeezerTrackDetails(topResult.id);
            const trackData = details || topResult;
            await db.addTrack(trackData);
            addedCount++;
          }
        } catch (err) {
          console.error(`[API Import] Failed to import text track "${line}":`, err.message);
        }
      }
      console.log(`[API Import] Text batch import completed. Added ${addedCount} tracks.`);
      worker.processQueue().catch(err => console.error(err));
    })();
  });

  // 8. Playlist import (Spotify or ListenBrainz): creates (or reuses) the
  // linked playlist(s), then matches and queues in the background. Importing a
  // URL again is a re-sync. A ListenBrainz user links all their sources.
  app.post('/api/v1/tracks/import-playlist', async (req, res) => {
    const { playlistUrl } = req.body;
    if (!playlistUrl) return res.status(400).json({ error: 'A Spotify or ListenBrainz URL is required' });
  
    try {
      const { linked, failed } = await sync.linkSources(playlistUrl);
      if (!linked.length) throw new Error(failed.map(f => f.error).join('; ') || 'Nothing to link');
      const parts = linked.map(({ playlist, source }) => `"${playlist.name}": ${source.tracks.length} tracks`);
      const skipped = failed.length ? ` Skipped: ${failed.map(f => `${f.id} (${f.error})`).join('; ')}.` : '';
      res.json({
        success: true,
        message: `Playlist ${parts.join(', ')}. Matching and queuing in the background.${skipped}`,
        count: linked.reduce((n, l) => n + l.source.tracks.length, 0),
        playlistId: linked[0].playlist.id,
        playlistIds: linked.map(l => l.playlist.id)
      });
      (async () => {
        for (const { playlist, source } of linked) await sync.syncPlaylist(playlist.id, source);
      })().catch(err => console.error('[API Import]', err.message));
    } catch (err) {
      res.status(500).json({ error: 'Playlist import failed', details: err.message });
    }
  });

  // 9. Playlists endpoints
  app.get('/api/v1/playlists', (req, res) => {
    res.json(db.getPlaylists());
  });

  app.post('/api/v1/playlists', async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Playlist name is required' });
    try {
      const pl = await db.createPlaylist(name, description);
      res.json(pl);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create playlist', details: err.message });
    }
  });

  app.delete('/api/v1/playlists/:id', async (req, res) => {
    try {
      const deleted = await db.deletePlaylist(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Playlist not found' });
    
      await worker.removeM3U(deleted.name);

      res.json({ success: true, deleted });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete playlist', details: err.message });
    }
  });

  // Sync options from a request body: syncHours (null = the global setting,
  // 0 = off) and addOnly. Returns { patch } or { error }.
  const syncOptions = ({ syncHours, addOnly } = {}) => {
    const patch = {};
    if (syncHours === null || syncHours === '') patch.syncHours = null;
    else if (syncHours !== undefined) {
      const h = Number(syncHours);
      if (!Number.isFinite(h) || h < 0) return { error: 'syncHours must be a number >= 0, or null' };
      patch.syncHours = h;
    }
    if (typeof addOnly === 'boolean') patch.addOnly = addOnly;
    return { patch };
  };

  // Bulk edit: { ids, patch: { syncHours?, addOnly? } } on several playlists.
  app.patch('/api/v1/playlists', async (req, res) => {
    const { ids, patch: body } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    const { patch, error } = syncOptions(body);
    if (error) return res.status(400).json({ error });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'patch needs syncHours or addOnly' });
    try {
      const updated = [];
      for (const id of new Set(ids)) {
        const done = await db.updatePlaylist(id, patch);
        if (done) updated.push(done.playlist);
      }
      res.json({ success: true, updated: updated.length, playlists: updated });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update playlists', details: err.message });
    }
  });

  // Bulk "Sync now": linked playlists among { ids }, one after another in the
  // background.
  app.post('/api/v1/playlists/sync', (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    const wanted = new Set(ids);
    const linked = db.getPlaylists().filter(p => wanted.has(p.id) && p.sourceId).map(p => p.id);
    (async () => {
      for (const id of linked) await sync.syncPlaylist(id).catch(err => console.error('[API Sync]', err.message));
    })();
    res.status(202).json({ success: true, message: `Syncing ${linked.length} linked playlist(s)`, count: linked.length });
  });

  // Rename (the M3U follows), edit the description, or set the sync options.
  app.patch('/api/v1/playlists/:id', async (req, res) => {
    try {
      const { name, description } = req.body;
      const { patch, error } = syncOptions(req.body);
      if (error) return res.status(400).json({ error });
      if (typeof name === 'string' && name.trim()) patch.name = name;
      if (typeof description === 'string') patch.description = description;
      const done = await db.updatePlaylist(req.params.id, patch);
      if (!done) return res.status(404).json({ error: 'Playlist not found' });
      if (done.playlist.name !== done.oldName) await worker.removeM3U(done.oldName);
      await worker.regenerateM3UPlaylist(db.getPlaylists().find(p => p.id === req.params.id));
      res.json(done.playlist);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update playlist', details: err.message });
    }
  });

  // "Sync now" for a linked playlist; runs in the background.
  app.post('/api/v1/playlists/:id/sync', (req, res) => {
    const pl = db.getPlaylists().find(p => p.id === req.params.id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (!pl.sourceId) return res.status(400).json({ error: 'Playlist is not linked to a source playlist' });
    sync.syncPlaylist(pl.id).catch(err => console.error('[API Sync]', err.message));
    res.status(202).json({ success: true, message: 'Sync started' });
  });

  // Manual match: { key, track } links a search result to a source track.
  app.post('/api/v1/playlists/:id/match', async (req, res) => {
    try {
      res.json(await sync.manualMatch(req.params.id, req.body?.key, req.body?.track));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/v1/playlists/:id/tracks', async (req, res) => {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'Track ID is required' });
  
    try {
      const playlist = await db.addTrackToPlaylist(req.params.id, trackId);
    
      // Regenerate M3U
      const playlists = db.getPlaylists();
      const updatedPl = playlists.find(p => p.id === req.params.id);
      // Since worker.js has the playlist generation, let's trigger it by matching
      // Or we can import / write it directly.
      res.json(updatedPl);
    } catch (err) {
      res.status(500).json({ error: 'Failed to add track to playlist', details: err.message });
    }
  });

  app.delete('/api/v1/playlists/:id/tracks/:trackId', async (req, res) => {
    try {
      const playlist = await db.removeTrackFromPlaylist(req.params.id, req.params.trackId);
      const playlists = db.getPlaylists();
      const updatedPl = playlists.find(p => p.id === req.params.id);
      res.json(updatedPl);
    } catch (err) {
      res.status(500).json({ error: 'Failed to remove track from playlist', details: err.message });
    }
  });

  // 10. Settings API
  app.get('/api/v1/settings', (req, res) => {
    res.json(maskSecrets(db.getSettings()));
  });

  app.post('/api/v1/settings', async (req, res) => {
    try {
      const oldSettings = db.getSettings();
      const incoming = unmaskSecrets(req.body);
      if (Array.isArray(incoming.inboxPaths)) {
        incoming.inboxPaths = [...new Set(incoming.inboxPaths.map(p => String(p).trim()).filter(Boolean))];
        const merged = { ...oldSettings, ...incoming };
        for (const p of incoming.inboxPaths) {
          const problem = inboxProblem(p, merged);
          if (problem) return res.status(400).json({ error: `Inbox ${p}: ${problem}` });
        }
      }
      const updated = await db.updateSettings(incoming);
    
      // If autoDownload status changed, adjust background worker
      if (oldSettings.autoDownload !== updated.autoDownload || oldSettings.downloadInterval !== updated.downloadInterval) {
        worker.stopWorker();
        worker.startWorker();
      }
    
      res.json(maskSecrets(updated));
    } catch (err) {
      res.status(500).json({ error: 'Failed to save settings', details: err.message });
    }
  });

  app.get('/api/v1/inbox', (req, res) => res.json({ attention: getAttention() }));

  // Test settings connection
  app.post('/api/v1/settings/test', async (req, res) => {
    try {
      // The UI only has masked secrets; test with the stored ones behind them.
      const results = await utils.testConnections({ ...db.getSettings(), ...unmaskSecrets(req.body) });
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: 'Failed to run connection tests', details: err.message });
    }
  });

  // 11. Trigger manual queue run
  app.post('/api/v1/downloads/trigger', (req, res) => {
    worker.processQueue()
      .then(() => console.log('[API] Manual queue processor trigger finished.'))
      .catch(err => console.error('[API] Manual queue processor error:', err));
  
    res.json({ success: true, message: 'Queue processor started in background' });
  });

  // 12. Status endpoint
  // Liveness for the container healthcheck: no disk or network work.
  app.get('/api/v1/health', (req, res) => res.json({ ok: true }));

  app.get('/api/v1/status', async (req, res) => {
    try {
      const tracks = db.getTracks();
      const settings = db.getSettings();
    
      const stats = {
        wanted: tracks.filter(t => t.status === 'wanted').length,
        snatched: tracks.filter(t => t.status === 'snatched').length,
        downloading: tracks.filter(t => t.status === 'downloading').length,
        downloaded: tracks.filter(t => t.status === 'downloaded').length,
        imported: tracks.filter(t => t.status === 'imported').length,
        failed: tracks.filter(t => t.status === 'failed').length,
        total: tracks.length,
        librarySize: '0 MB'
      };

      // Walking the library is slow on a big NFS share (69 s for ~1,750
      // artists on icebox), so it runs in the background and is cached.
      stats.librarySize = librarySize(settings.libraryPath);

      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch status stats', details: err.message });
    }
  });

  // === SERVE STATIC REACT FRONTEND IN PRODUCTION ===
  app.use(express.static(DIST_DIR));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });

  return app;
}
