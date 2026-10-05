import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { promisify } from 'util';
import nodeID3 from 'node-id3';

const execFileAsync = promisify(execFile);

const YTDLP_PATH = path.resolve('bin/yt-dlp');
const FFMPEG_PATH = path.resolve('bin/ffmpeg');
const FFPROBE_PATH = path.resolve('bin/ffprobe');

export async function getFileDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_PATH, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nocr=1',
      filePath
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch (err) {
    console.error(`[Utils] ffprobe failed for ${filePath}:`, err.message);
    return 0;
  }
}

// === DEEZER METADATA SEARCH ===
export async function searchDeezer(query) {
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Deezer API error: ${response.status}`);
    
    const data = await response.json();
    if (!data.data) return [];
    
    return data.data.map(track => ({
      id: String(track.id),
      title: track.title,
      artist: track.artist.name,
      artists: [track.artist.name],
      album: track.album.title,
      albumArt: track.album.cover_big || track.album.cover_medium || '',
      duration: track.duration, // seconds
      isrc: '', // Can be loaded via details if needed
      link: track.link
    }));
  } catch (err) {
    console.error('Deezer search failed:', err);
    return [];
  }
}

export async function getDeezerTrackDetails(trackId) {
  try {
    const response = await fetch(`https://api.deezer.com/track/${trackId}`);
    if (!response.ok) return null;
    const track = await response.json();
    return {
      id: String(track.id),
      title: track.title,
      artist: track.artist.name,
      artists: [track.artist.name],
      album: track.album.title,
      albumArt: track.album.cover_xl || track.album.cover_big || '',
      duration: track.duration,
      isrc: track.isrc || '',
      releaseDate: track.release_date || '',
      trackNumber: track.track_position || 1
    };
  } catch (err) {
    console.error(`Failed to get Deezer track details for ${trackId}:`, err);
    return null;
  }
}

// Helper to recursively find a track-like array in nested object
function findTracksRecursively(obj) {
  if (!obj || typeof obj !== 'object') return null;
  
  if (Array.isArray(obj)) {
    const isTrackArray = obj.length > 0 && obj.every(item => {
      return item && typeof item === 'object' && (item.title || item.name) && (item.subtitle || item.artists || item.artist);
    });
    if (isTrackArray) return obj;
    
    for (const item of obj) {
      const found = findTracksRecursively(item);
      if (found) return found;
    }
  } else {
    for (const key in obj) {
      // Avoid circular references or massive system properties
      if (key === 'window' || key === 'global' || key === 'req' || key === 'res') continue;
      const found = findTracksRecursively(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

// === SPOTIFY PLAYLIST EMBED SCRAPER ===
// This allows scraping public Spotify playlist tracks without developer API credentials.
export async function parseSpotifyPlaylist(playlistUrlOrId) {
  try {
    let playlistId = playlistUrlOrId;
    if (playlistUrlOrId.includes('spotify.com')) {
      const match = playlistUrlOrId.match(/playlist\/([a-zA-Z0-9]+)/);
      if (match) {
        playlistId = match[1];
      } else {
        throw new Error('Invalid Spotify playlist URL format');
      }
    }
    
    const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
    const response = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) throw new Error(`Spotify embed fetch failed: ${response.status}`);
    const html = await response.text();
    
    // Extract JSON payload from Next.js state
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!jsonMatch) {
      // Fallback regex to capture track information from simple HTML or secondary scripts
      const fallbackTracks = [];
      const trackRegex = /"name":"([^"]+)","artists":\[{"name":"([^"]+)"/g;
      let match;
      while ((match = trackRegex.exec(html)) !== null) {
        const title = decodeURIComponent(JSON.parse(`"${match[1]}"`));
        const artist = decodeURIComponent(JSON.parse(`"${match[2]}"`));
        if (title && artist && !fallbackTracks.some(t => t.title === title && t.artist === artist)) {
          fallbackTracks.push({ title, artist });
        }
      }
      if (fallbackTracks.length > 0) return fallbackTracks;
      throw new Error('Could not find NEXT_DATA script in Spotify embed page');
    }
    
    const state = JSON.parse(jsonMatch[1]);
    const items = findTracksRecursively(state);
    
    if (!items || items.length === 0) {
      throw new Error('No tracks found in playlist data structure');
    }
    
    return items.map(item => {
      const title = item.title || item.name;
      const artist = item.subtitle || (item.artists && item.artists[0]?.name) || item.artist?.name || 'Unknown Artist';
      const artists = item.artists ? (Array.isArray(item.artists) ? item.artists.map(a => a.name || a) : [item.artists]) : [artist];
      return {
        title,
        artist,
        artists,
        album: item.album?.name || '',
        durationMs: item.duration_ms || item.duration || 0,
        spotifyId: item.id || item.uri
      };
    });
  } catch (err) {
    console.error('Spotify playlist parsing failed:', err);
    throw err;
  }
}

// === YT-DLP AUDIO DOWNLOAD & TRANSCODING ===

// Search and get top candidate YouTube videos for matching
export async function searchYouTube(query, limit = 5) {
  try {
    const args = [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--ffmpeg-location', FFMPEG_PATH,
      '--no-playlist'
    ];
    
    const { stdout } = await execFileAsync(YTDLP_PATH, args);
    const lines = stdout.trim().split('\n').filter(Boolean);
    
    return lines.map(line => {
      try {
        const json = JSON.parse(line);
        return {
          id: json.id,
          title: json.title,
          url: json.webpage_url,
          duration: json.duration, // seconds
          viewCount: json.view_count || 0,
          channel: json.channel || json.uploader || ''
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.error('YouTube search failed:', err);
    return [];
  }
}

// Perform download and extract audio
export async function downloadTrackAudio(youtubeUrl, outputFile, format = 'mp3', quality = '320k') {
  const tempDir = path.resolve('temp');
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempOutBase = path.join(tempDir, `download_${Date.now()}`);
  const tempOutFile = `${tempOutBase}.${format}`;

  const args = [
    youtubeUrl,
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', quality === '320k' ? '0' : '5', // yt-dlp maps 0=best, 9=worst for VBR, or we can use specific bitrates
    '--output', `${tempOutBase}.%(ext)s`,
    '--ffmpeg-location', FFMPEG_PATH,
    '--no-playlist'
  ];
  
  if (format === 'mp3') {
    args.push('--audio-quality', quality.replace('k', ''));
  }

  try {
    await execFileAsync(YTDLP_PATH, args);
    // Verify file exists
    await fs.access(tempOutFile);
    
    // Ensure parent directories of outputFile exist
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    
    // Copy/move file to final location
    await fs.copyFile(tempOutFile, outputFile);
    await fs.unlink(tempOutFile);
    return true;
  } catch (err) {
    console.error(`Download failed for ${youtubeUrl}:`, err);
    // Cleanup any partial files
    try {
      await fs.unlink(tempOutFile);
    } catch (e) {}
    throw err;
  }
}

// === ID3 METADATA WRITER ===
export async function tagAudioFile(filePath, trackMetadata) {
  try {
    let imageBuffer = null;
    
    if (trackMetadata.albumArt) {
      try {
        const res = await fetch(trackMetadata.albumArt);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          imageBuffer = Buffer.from(ab);
        }
      } catch (imgErr) {
        console.error('Failed to download album art for tagging:', imgErr);
      }
    }
    
    const artistString = Array.isArray(trackMetadata.artists) 
      ? trackMetadata.artists.join(', ') 
      : trackMetadata.artist;

    const tags = {
      title: trackMetadata.title,
      artist: artistString,
      album: trackMetadata.album,
      comment: {
        language: 'eng',
        text: 'Downloaded by Songarr'
      }
    };

    if (trackMetadata.releaseDate) {
      const year = trackMetadata.releaseDate.split('-')[0];
      if (year) {
        tags.year = year;
      }
    }

    if (trackMetadata.trackNumber) {
      tags.trackNumber = String(trackMetadata.trackNumber);
    }

    if (imageBuffer) {
      tags.image = {
        mime: 'image/jpeg',
        type: {
          id: 3,
          name: 'front cover'
        },
        description: 'Album Art',
        imageBuffer: imageBuffer
      };
    }

    const success = nodeID3.write(tags, filePath);
    if (!success) {
      throw new Error('node-id3 returned false');
    }
    return true;
  } catch (err) {
    console.error('Error tagging file:', err);
    // Do not throw, return false so the worker knows tagging failed but audio was downloaded
    return false;
  }
}

// === INDEXER SEARCH (PROWLARR / JACKETT) ===
export async function searchIndexer(query, settings) {
  const type = settings.indexerType || 'prowlarr';
  const url = settings.prowlarrUrl ? settings.prowlarrUrl.replace(/\/$/, '') : '';
  const apiKey = settings.prowlarrApiKey || '';
  
  if (!url) {
    throw new Error('Indexer URL not configured');
  }

  try {
    if (type === 'prowlarr') {
      const searchUrl = `${url}/api/v1/search?query=${encodeURIComponent(query)}&categories=3000&apikey=${apiKey}`;
      const response = await fetch(searchUrl);
      if (!response.ok) throw new Error(`Prowlarr error: ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) return [];
      
      return data.map(item => ({
        title: item.title,
        downloadUrl: item.downloadUrl,
        guid: item.guid || item.infoHash || '',
        size: item.size || 0,
        seeders: item.seeders || 0,
        peers: item.peers || 0,
        indexer: item.indexer || 'Prowlarr'
      }));
    } else {
      // Jackett
      const searchUrl = `${url}/api/v2.0/indexers/all/results?apikey=${apiKey}&Query=${encodeURIComponent(query)}&Category=3000`;
      const response = await fetch(searchUrl);
      if (!response.ok) throw new Error(`Jackett error: ${response.status}`);
      const data = await response.json();
      if (!data.Results) return [];
      
      return data.Results.map(item => ({
        title: item.Title,
        downloadUrl: item.Link,
        guid: item.Guid || '',
        size: item.Size || 0,
        seeders: item.Seeders || 0,
        peers: item.Peers || 0,
        indexer: item.Tracker || 'Jackett'
      }));
    }
  } catch (err) {
    console.error(`[Indexer] Search failed for query "${query}":`, err.message);
    throw err;
  }
}

// Keep track of sessions to avoid authenticating on every single poll
const sessions = new Map();

class ClientSession {
  constructor(url, username, password) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.cookies = '';
    this.sessionId = '';
  }
  
  async request(path, options = {}) {
    const headers = { ...options.headers };
    if (this.cookies) {
      headers['Cookie'] = this.cookies;
    }
    if (this.sessionId) {
      headers['X-Transmission-Session-Id'] = this.sessionId;
    }
    if (this.username) {
      headers['Authorization'] = 'Basic ' + Buffer.from(this.username + ':' + (this.password || '')).toString('base64');
    }
    
    let response;
    try {
      response = await fetch(`${this.url}${path}`, { ...options, headers });
    } catch (e) {
      throw e;
    }
    
    // Transmission Session-ID handling
    if (response.status === 409) {
      const newSessionId = response.headers.get('X-Transmission-Session-Id');
      if (newSessionId) {
        this.sessionId = newSessionId;
        headers['X-Transmission-Session-Id'] = this.sessionId;
        response = await fetch(`${this.url}${path}`, { ...options, headers });
      }
    }
    
    // Capture set-cookie
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cleanCookie = setCookie.split(';')[0];
      this.cookies = cleanCookie;
    }
    
    return response;
  }
}

export function getDownloadClient(settings) {
  const clientType = settings.torrentClient || 'qbittorrent';
  const url = settings.torrentClientUrl ? settings.torrentClientUrl.replace(/\/$/, '') : '';
  const username = settings.torrentClientUsername || '';
  const password = settings.torrentClientPassword || '';
  
  const sessionKey = `${clientType}_${url}`;
  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, new ClientSession(url, username, password));
  }
  const session = sessions.get(sessionKey);

  return {
    async addTorrent(downloadUrl) {
      if (clientType === 'qbittorrent') {
        await session.request('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        });
        
        const addRes = await session.request('/api/v2/torrents/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `urls=${encodeURIComponent(downloadUrl)}`
        });
        if (!addRes.ok) throw new Error(`qBittorrent add failed: ${addRes.status}`);
        return true;
      }
      
      if (clientType === 'deluge') {
        const loginRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'auth.login', params: [password], id: 1 })
        });
        const loginJson = await loginRes.json();
        if (loginJson.error) throw new Error(`Deluge login failed: ${loginJson.error.message}`);
        
        const addRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'core.add_torrent_url', params: [downloadUrl, {}], id: 2 })
        });
        const addJson = await addRes.json();
        if (addJson.error) throw new Error(`Deluge add failed: ${addJson.error.message}`);
        return addJson.result; // Torrent hash
      }
      
      if (clientType === 'transmission') {
        const addRes = await session.request('/transmission/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'torrent-add',
            arguments: { filename: downloadUrl }
          })
        });
        const addJson = await addRes.json();
        if (addJson.result !== 'success') throw new Error(`Transmission add failed: ${addJson.result}`);
        const added = addJson.arguments['torrent-added'] || addJson.arguments['torrent-duplicate'];
        return added.hashString;
      }
      
      if (clientType === 'sabnzbd') {
        const addRes = await fetch(`${url}/sabnzbd/api?mode=addurl&name=${encodeURIComponent(downloadUrl)}&output=json&apikey=${password}`);
        if (!addRes.ok) throw new Error(`SABnzbd add failed: ${addRes.status}`);
        const addJson = await addRes.json();
        if (!addJson.status) throw new Error(`SABnzbd add failed: ${addJson.error || 'unknown error'}`);
        return addJson.nzo_ids[0]; // NZB job id
      }
      
      throw new Error(`Unsupported download client type: ${clientType}`);
    },
    
    async getProgress(hash) {
      if (clientType === 'qbittorrent') {
        await session.request('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        });

        const infoRes = await session.request(`/api/v2/torrents/info?hashes=${hash}`);
        if (!infoRes.ok) throw new Error(`qBittorrent info failed: ${infoRes.status}`);
        const info = await infoRes.json();
        if (info.length === 0) return null;
        
        const torrent = info[0];
        
        let files = [];
        try {
          const filesRes = await session.request(`/api/v2/torrents/files?hash=${hash}`);
          if (filesRes.ok) {
            const filesData = await filesRes.json();
            files = filesData.map(f => f.name);
          }
        } catch (e) {
          console.error('[qBittorrent] Failed to get files:', e.message);
        }

        return {
          progress: Math.round(torrent.progress * 100),
          isFinished: torrent.progress === 1 || ['uploading', 'pausedUP', 'stalledUP', 'checkingUP'].includes(torrent.state),
          savePath: torrent.save_path,
          name: torrent.name,
          files
        };
      }
      
      if (clientType === 'deluge') {
        const statusRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'core.get_torrent_status',
            params: [hash, ['progress', 'state', 'save_path', 'files', 'name']],
            id: 3
          })
        });
        const statusJson = await statusRes.json();
        if (statusJson.error || !statusJson.result) return null;
        
        const torrent = statusJson.result;
        return {
          progress: Math.round(torrent.progress),
          isFinished: torrent.progress === 100 || ['Seeding', 'Paused'].includes(torrent.state),
          savePath: torrent.save_path,
          name: torrent.name,
          files: torrent.files ? torrent.files.map(f => f.path) : []
        };
      }
      
      if (clientType === 'transmission') {
        const statusRes = await session.request('/transmission/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'torrent-get',
            arguments: {
              ids: [hash],
              fields: ['id', 'hashString', 'name', 'percentDone', 'status', 'files', 'downloadDir']
            }
          })
        });
        const statusJson = await statusRes.json();
        if (statusJson.result !== 'success') return null;
        const torrents = statusJson.arguments.torrents;
        if (!torrents || torrents.length === 0) return null;
        
        const torrent = torrents[0];
        return {
          progress: Math.round(torrent.percentDone * 100),
          isFinished: torrent.percentDone === 1 || torrent.status === 6,
          savePath: torrent.downloadDir,
          name: torrent.name,
          files: torrent.files ? torrent.files.map(f => f.name) : []
        };
      }
      
      if (clientType === 'sabnzbd') {
        const qRes = await fetch(`${url}/sabnzbd/api?mode=queue&output=json&apikey=${password}`);
        if (!qRes.ok) throw new Error(`SABnzbd queue fetch failed: ${qRes.status}`);
        const qJson = await qRes.json();
        
        const slot = qJson.queue?.slots?.find(s => s.nzo_id === hash);
        if (slot) {
          const progress = parseInt(slot.percentage) || 0;
          return {
            progress,
            isFinished: false,
            savePath: '',
            name: slot.filename,
            files: []
          };
        }
        
        const hRes = await fetch(`${url}/sabnzbd/api?mode=history&output=json&apikey=${password}`);
        if (hRes.ok) {
          const hJson = await hRes.json();
          const histSlot = hJson.history?.slots?.find(s => s.nzo_id === hash);
          if (histSlot) {
            return {
              progress: 100,
              isFinished: histSlot.status === 'Completed',
              savePath: histSlot.storage || '',
              name: histSlot.name,
              files: []
            };
          }
        }
        
        return null;
      }
      
      throw new Error(`Unsupported download client type: ${clientType}`);
    },
    
    async removeTorrent(hash, deleteFiles = true) {
      if (clientType === 'qbittorrent') {
        await session.request('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        });
        const delRes = await session.request('/api/v2/torrents/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `hashes=${hash}&deleteFiles=${deleteFiles}`
        });
        return delRes.ok;
      }
      
      if (clientType === 'deluge') {
        const delRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'core.remove_torrent',
            params: [hash, deleteFiles],
            id: 4
          })
        });
        const delJson = await delRes.json();
        return !delJson.error;
      }
      
      if (clientType === 'transmission') {
        const delRes = await session.request('/transmission/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'torrent-remove',
            arguments: {
              ids: [hash],
              'delete-local-data': deleteFiles
            }
          })
        });
        const delJson = await delRes.json();
        return delJson.result === 'success';
      }
      
      if (clientType === 'sabnzbd') {
        const delRes = await fetch(`${url}/sabnzbd/api?mode=queue&name=delete&value=${hash}&del_files=${deleteFiles ? 1 : 0}&apikey=${password}`);
        if (!delRes.ok) return false;
        const delJson = await delRes.json();
        
        await fetch(`${url}/sabnzbd/api?mode=history&name=delete&value=${hash}&del_files=${deleteFiles ? 1 : 0}&apikey=${password}`);
        
        return delJson.status === true;
      }
      
      return false;
    }
  };
}

export async function testConnections(settings) {
  const results = {
    indexer: { success: false, message: 'Not tested' },
    downloadClient: { success: false, message: 'Not tested' }
  };
  
  if (settings.prowlarrUrl) {
    try {
      const searchRes = await searchIndexer('Midnight City', settings);
      results.indexer = {
        success: true,
        message: `Connection successful! Found ${searchRes.length} results.`
      };
    } catch (e) {
      results.indexer = {
        success: false,
        message: `Connection failed: ${e.message}`
      };
    }
  }
  
  if (settings.torrentClientUrl) {
    try {
      const client = getDownloadClient(settings);
      if (settings.torrentClient === 'qbittorrent') {
        const sessionKey = `qbittorrent_${settings.torrentClientUrl.replace(/\/$/, '')}`;
        if (!sessions.has(sessionKey)) {
          sessions.set(sessionKey, new ClientSession(settings.torrentClientUrl.replace(/\/$/, ''), settings.torrentClientUsername || '', settings.torrentClientPassword || ''));
        }
        const session = sessions.get(sessionKey);
        await session.request('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(settings.torrentClientUsername || '')}&password=${encodeURIComponent(settings.torrentClientPassword || '')}`
        });
        results.downloadClient = { success: true, message: 'Connected to qBittorrent successfully!' };
      } else if (settings.torrentClient === 'deluge') {
        const sessionKey = `deluge_${settings.torrentClientUrl.replace(/\/$/, '')}`;
        if (!sessions.has(sessionKey)) {
          sessions.set(sessionKey, new ClientSession(settings.torrentClientUrl.replace(/\/$/, ''), '', settings.torrentClientPassword || ''));
        }
        const session = sessions.get(sessionKey);
        const loginRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'auth.login', params: [settings.torrentClientPassword || ''], id: 1 })
        });
        const loginJson = await loginRes.json();
        if (loginJson.error) throw new Error(loginJson.error.message);
        results.downloadClient = { success: true, message: 'Connected to Deluge successfully!' };
      } else if (settings.torrentClient === 'transmission') {
        await client.getProgress('test_hash');
        results.downloadClient = { success: true, message: 'Connected to Transmission successfully!' };
      } else if (settings.torrentClient === 'sabnzbd') {
        const qRes = await fetch(`${settings.torrentClientUrl.replace(/\/$/, '')}/sabnzbd/api?mode=queue&output=json&apikey=${settings.torrentClientPassword}`);
        if (!qRes.ok) throw new Error(`HTTP ${qRes.status}`);
        const qJson = await qRes.json();
        if (qJson.error) throw new Error(qJson.error);
        results.downloadClient = { success: true, message: 'Connected to SABnzbd successfully!' };
      }
    } catch (e) {
      results.downloadClient = {
        success: false,
        message: `Connection failed: ${e.message}`
      };
    }
  }
  
  return results;
}
