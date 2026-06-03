import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import * as db from './db.js';
import * as utils from './utils.js';
import * as worker from './worker.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize Database & Worker
await db.init();
worker.startWorker();

// === API ROUTES ===

// 1. Search tracks
app.get('/api/v1/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  
  try {
    const results = await utils.searchDeezer(query);
    
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
    if (!trackData.album || !trackData.albumArt || !trackData.duration) {
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

// 8. Spotify playlist import
app.post('/api/v1/tracks/import-playlist', async (req, res) => {
  const { playlistUrl } = req.body;
  if (!playlistUrl) return res.status(400).json({ error: 'Spotify playlist URL is required' });
  
  try {
    console.log(`[API Import] Parsing Spotify playlist: ${playlistUrl}`);
    const parsedTracks = await utils.parseSpotifyPlaylist(playlistUrl);
    
    res.json({ 
      success: true, 
      message: `Successfully parsed ${parsedTracks.length} tracks. Starting search and queue add in background.`,
      count: parsedTracks.length
    });
    
    // Process matching in the background
    (async () => {
      let imported = 0;
      for (const track of parsedTracks) {
        try {
          const query = `${track.artist} - ${track.title}`;
          console.log(`[API Import] Matching playlist track: "${query}"`);
          const results = await utils.searchDeezer(query);
          
          if (results.length > 0) {
            // Find a good match (exact or close title match)
            const match = results[0];
            const details = await utils.getDeezerTrackDetails(match.id);
            await db.addTrack(details || match);
            imported++;
          }
        } catch (e) {
          console.error(`[API Import] Failed to import Spotify track: ${track.artist} - ${track.title}`, e.message);
        }
      }
      console.log(`[API Import] Playlist import finished. Snatched ${imported} out of ${parsedTracks.length} tracks.`);
      worker.processQueue().catch(err => console.error(err));
    })();
    
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
    
    // Also remove the physical M3U file if it exists
    const settings = db.getSettings();
    const m3uFile = path.join(settings.libraryPath, 'Playlists', `${deleted.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u`);
    try {
      await fs.unlink(m3uFile);
    } catch (e) {}

    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete playlist', details: err.message });
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
  res.json(db.getSettings());
});

app.post('/api/v1/settings', async (req, res) => {
  try {
    const oldSettings = db.getSettings();
    const updated = await db.updateSettings(req.body);
    
    // If autoDownload status changed, adjust background worker
    if (oldSettings.autoDownload !== updated.autoDownload || oldSettings.downloadInterval !== updated.downloadInterval) {
      worker.stopWorker();
      worker.startWorker();
    }
    
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings', details: err.message });
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

    // Calculate library disk space
    try {
      let sizeBytes = 0;
      async function walkDir(dir) {
        try {
          const files = await fs.readdir(dir, { withFileTypes: true });
          for (const file of files) {
            const p = path.join(dir, file.name);
            if (file.isDirectory()) {
              await walkDir(p);
            } else if (file.isFile() && (file.name.endsWith('.mp3') || file.name.endsWith('.m4a'))) {
              const stat = await fs.stat(p);
              sizeBytes += stat.size;
            }
          }
        } catch (e) {}
      }
      
      await walkDir(settings.libraryPath);
      stats.librarySize = (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB';
    } catch (e) {
      stats.librarySize = 'Unknown';
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status stats', details: err.message });
  }
});

// === SERVE STATIC REACT FRONTEND IN PRODUCTION ===
const distPath = path.resolve('dist');
app.use(express.static(distPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Songarr Server] Running on http://localhost:${PORT}`);
});
