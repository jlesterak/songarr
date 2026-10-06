import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR, MUSIC_DIR } from './config.js';

const DB_DIR = DATA_DIR;
const DB_FILE = path.join(DB_DIR, 'db.json');

// Memory cache for fast reads
let db = {
  tracks: [],
  playlists: [],
  settings: {
    libraryPath: MUSIC_DIR,
    autoDownload: true,
    downloadInterval: 5, // minutes
    audioFormat: 'mp3',
    audioQuality: '320k', // default to high quality 320kbps
    navidromeUrl: '',
    navidromeUsername: '',
    navidromePassword: '', // the Subsonic token is derived per request (md5(password + random salt))
    spotifyPlaylistUrls: [],
    
    // Phase 2 features
    downloadMethod: 'direct', // 'direct' or 'torrent'
    albumDownloadMode: 'single', // 'single' or 'album'
    indexerType: 'prowlarr', // 'prowlarr' or 'jackett'
    prowlarrUrl: '',
    prowlarrApiKey: '',
    torrentClient: 'qbittorrent', // 'qbittorrent', 'deluge', 'transmission', 'sabnzbd'
    torrentClientUrl: 'http://localhost:8080',
    torrentClientUsername: '',
    torrentClientPassword: '',
    // Remote path mapping, like the *arrs: the client reports its own save path
    // (e.g. /downloads in its container); Songarr rewrites that prefix to where
    // the same files are mounted here.
    downloadPathRemote: '',
    downloadPathLocal: '',
    // Seeding: keep the torrent in the client after import, removing it (and
    // its download files) once a ratio or seed-time limit is reached; 0 = no
    // limit, so it seeds until removed by hand. The library copy is a hardlink
    // where possible, so it costs no extra space and survives the removal.
    seedAfterImport: true,
    seedRatioLimit: 0,
    seedTimeLimitHours: 0,
    importMode: 'hardlink', // 'hardlink' or 'copy'
    // A torrent that makes no progress for this long is dropped and the next
    // candidate tried (public indexers report seeders for dead torrents);
    // after maxTorrentAttempts dead ones, YouTube.
    stallTimeoutMinutes: 30,
    maxTorrentAttempts: 3,
    // deemix (Deezer, FLAC with a paid account) is tried first when its URL is
    // set. No ARL here means use the one deemix has saved. Path mapping as for
    // the torrent client: deemix's download path -> where Songarr sees it.
    deemixUrl: '',
    deemixArl: '',
    deemixPathRemote: '',
    deemixPathLocal: '',
    qualityRules: [] // array of { id, type, name, format, quality }
  }
};

// Atomically save DB to disk
async function save() {
  await fs.mkdir(DB_DIR, { recursive: true });
  const tempFile = `${DB_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf-8');
  await fs.rename(tempFile, DB_FILE);
}

export async function init() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Merge read data with defaults to ensure schema updates
    db = {
      tracks: parsed.tracks || [],
      playlists: parsed.playlists || [],
      settings: { ...db.settings, ...(parsed.settings || {}) }
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading database:', err);
    }
    // Save defaults
    await save();
  }

  // Crash recovery. A download the client already holds (it has a hash) keeps
  // going: polling resumes, and an interrupted import re-runs once polling sees
  // it finished. Re-queuing it instead would grab a duplicate the client
  // rejects. Anything interrupted before reaching a client goes back to wanted.
  let recovered = false;
  db.tracks.forEach(track => {
    if (!['snatched', 'downloading', 'downloaded'].includes(track.status)) return;
    if (track.torrentHash || track.deemixUuid) {
      if (track.status === 'downloaded') {
        track.status = 'downloading';
        recovered = true;
      }
      return;
    }
    track.status = 'wanted';
    track.error = null;
    recovered = true;
  });
  if (recovered) {
    console.log('[DB] Recovered pending tracks back to "wanted" status.');
    await save();
  }
  
  // Ensure libraryPath directory exists
  try {
    await fs.mkdir(db.settings.libraryPath, { recursive: true });
  } catch (e) {
    console.error('Failed to create library path:', db.settings.libraryPath, e);
  }
}

// === Settings API ===
export function getSettings() {
  return { ...db.settings };
}

export async function updateSettings(newSettings) {
  db.settings = { ...db.settings, ...newSettings };
  
  // Ensure library directory exists
  try {
    await fs.mkdir(db.settings.libraryPath, { recursive: true });
  } catch (e) {
    // Ignore error
  }
  
  await save();
  return db.settings;
}

// === Tracks / Queue API ===
export function getTracks() {
  return [...db.tracks];
}

export function getTrack(id) {
  return db.tracks.find(t => t.id === id) || null;
}

export async function addTrack(trackData) {
  // Check if track already exists in database
  const existing = db.tracks.find(t => t.id === trackData.id);
  if (existing) {
    // If it failed previously, reset to wanted
    if (existing.status === 'failed' || existing.status === 'none') {
      existing.status = 'wanted';
      existing.error = null;
      existing.deemixTried = false;
      existing.createdAt = new Date().toISOString();
      await save();
      return existing;
    }
    return existing;
  }

  // Lifecycle fields belong to the server: a client posting a search result
  // as-is (status 'none') must not stop the track from being queued.
  const { status, error, createdAt, filePath, torrentHash, deemixUuid, deemixTried, ...metadata } = trackData;
  const track = {
    id: trackData.id,
    title: trackData.title,
    artists: Array.isArray(trackData.artists) ? trackData.artists : [trackData.artist],
    album: trackData.album || 'Unknown Album',
    albumArt: trackData.albumArt || '',
    duration: trackData.duration || 0, // seconds
    isrc: trackData.isrc || '',
    status: 'wanted', // 'wanted', 'snatched', 'downloading', 'downloaded', 'imported', 'failed'
    error: null,
    createdAt: new Date().toISOString(),
    filePath: '',
    ...metadata
  };

  db.tracks.push(track);
  await save();
  return track;
}

export async function updateTrack(id, updates) {
  const index = db.tracks.findIndex(t => t.id === id);
  if (index !== -1) {
    db.tracks[index] = { ...db.tracks[index], ...updates };
    await save();
    return db.tracks[index];
  }
  return null;
}

export async function deleteTrack(id) {
  const index = db.tracks.findIndex(t => t.id === id);
  if (index !== -1) {
    const deleted = db.tracks.splice(index, 1)[0];
    await save();
    return deleted;
  }
  return null;
}

export async function clearQueue() {
  db.tracks = db.tracks.filter(t => t.status === 'imported');
  await save();
}

// === Playlists API ===
export function getPlaylists() {
  return db.playlists.map(pl => {
    // Map tracks fully
    const fullTracks = pl.trackIds
      .map(tid => db.tracks.find(t => t.id === tid))
      .filter(Boolean);
    return { ...pl, tracks: fullTracks };
  });
}

export async function createPlaylist(name, description = '') {
  const playlist = {
    id: 'pl_' + Math.random().toString(36).substr(2, 9),
    name,
    description,
    trackIds: [],
    createdAt: new Date().toISOString()
  };
  
  db.playlists.push(playlist);
  await save();
  return playlist;
}

export async function deletePlaylist(id) {
  const index = db.playlists.findIndex(p => p.id === id);
  if (index !== -1) {
    const deleted = db.playlists.splice(index, 1)[0];
    await save();
    return deleted;
  }
  return null;
}

export async function addTrackToPlaylist(playlistId, trackId) {
  const playlist = db.playlists.find(p => p.id === playlistId);
  if (!playlist) throw new Error('Playlist not found');
  
  if (!playlist.trackIds.includes(trackId)) {
    playlist.trackIds.push(trackId);
    await save();
  }
  return playlist;
}

export async function removeTrackFromPlaylist(playlistId, trackId) {
  const playlist = db.playlists.find(p => p.id === playlistId);
  if (!playlist) throw new Error('Playlist not found');
  
  playlist.trackIds = playlist.trackIds.filter(tid => tid !== trackId);
  await save();
  return playlist;
}
