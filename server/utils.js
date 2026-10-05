import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { promisify } from 'util';
import crypto from 'crypto';
import nodeID3 from 'node-id3';
import { binary, TEMP_DIR } from './config.js';

const execFileAsync = promisify(execFile);

const YTDLP_PATH = binary('yt-dlp');
const FFMPEG_PATH = binary('ffmpeg');
const FFPROBE_PATH = binary('ffprobe');

export async function getFileDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_PATH, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0', // portable: Alpine's ffprobe rejects default's nocr option
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
      // Flat: search metadata only. Full --dump-json lists every format URL,
      // ~200 KB per video, which overflowed execFile's buffer.
      '--flat-playlist',
      '--dump-json',
      ...ytdlpCommonArgs(),
      '--no-playlist'
    ];
    
    const { stdout } = await execFileAsync(YTDLP_PATH, args, { maxBuffer: 16 * 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    
    return lines.map(line => {
      try {
        const json = JSON.parse(line);
        return {
          id: json.id,
          title: json.title,
          url: json.webpage_url || json.url,
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

// Arguments every yt-dlp call needs: where ffmpeg lives (only when it isn't
// on PATH), and Node as the JS runtime YouTube's player challenges now need
// (yt-dlp only enables Deno by default).
function ytdlpCommonArgs() {
  const args = ['--js-runtimes', `node:${process.execPath}`];
  if (path.isAbsolute(FFMPEG_PATH)) args.push('--ffmpeg-location', FFMPEG_PATH);
  return args;
}

// yt-dlp takes either a VBR level (0 best .. 10 worst) or a bitrate with a K
// suffix. '320k' -> '320K'; anything else falls back to best VBR.
export function audioQualityArg(quality) {
  const m = /^(\d+)k$/i.exec(String(quality || ''));
  return m ? `${m[1]}K` : '0';
}

// Perform download and extract audio
export async function downloadTrackAudio(youtubeUrl, outputFile, format = 'mp3', quality = '320k') {
  const tempDir = TEMP_DIR;
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempOutBase = path.join(tempDir, `download_${Date.now()}`);
  const tempOutFile = `${tempOutBase}.${format}`;

  const args = [
    youtubeUrl,
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', audioQualityArg(quality),
    '--output', `${tempOutBase}.%(ext)s`,
    ...ytdlpCommonArgs(),
    '--no-playlist'
  ];

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
        infoHash: item.infoHash || '',
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
        infoHash: item.InfoHash || '',
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

// End offset of the bencoded value starting at i (throws on malformed input).
function bencodeEnd(buf, i) {
  const c = buf[i];
  if (c === 0x69) { // i<int>e
    const e = buf.indexOf(0x65, i);
    if (e < 0) throw new Error('bad int');
    return e + 1;
  }
  if (c === 0x6c || c === 0x64) { // list / dict
    i++;
    while (buf[i] !== 0x65) {
      if (i >= buf.length) throw new Error('unterminated');
      i = bencodeEnd(buf, i);
    }
    return i + 1;
  }
  const colon = buf.indexOf(0x3a, i); // <len>:<bytes>
  const len = Number(buf.subarray(i, colon).toString());
  if (colon < 0 || !Number.isInteger(len) || len < 0) throw new Error('bad string');
  return colon + 1 + len;
}

// Info hash of a .torrent file: SHA-1 of the raw bencoded "info" dict.
export function torrentInfoHash(buf) {
  try {
    if (buf[0] !== 0x64) return '';
    let i = 1;
    while (i < buf.length && buf[i] !== 0x65) {
      const keyEnd = bencodeEnd(buf, i);
      const key = buf.subarray(buf.indexOf(0x3a, i) + 1, keyEnd).toString();
      const valEnd = bencodeEnd(buf, keyEnd);
      if (key === 'info') return crypto.createHash('sha1').update(buf.subarray(keyEnd, valEnd)).digest('hex');
      i = valEnd;
    }
  } catch {
    // malformed: let the tag lookup find the torrent instead
  }
  return '';
}

// Indexer download links point at Prowlarr/Jackett, which the client often
// can't reach (e.g. qBittorrent in a VPN container with its own DNS). Like the
// *arrs, fetch the .torrent here and hand the client the file itself; links
// that redirect to (or return) a magnet are passed on as magnets.
export async function fetchTorrent(downloadUrl) {
  let url = downloadUrl;
  for (let hop = 0; hop < 5; hop++) {
    if (/^magnet:/i.test(url)) return { magnet: url, infoHash: infoHashFromMagnet(url) };
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`Redirect without a location from the indexer (HTTP ${res.status})`);
      url = new URL(location, url).href;
      continue;
    }
    if (!res.ok) throw new Error(`Torrent download from the indexer failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 7).toString() === 'magnet:') {
      const magnet = buf.toString().trim();
      return { magnet, infoHash: infoHashFromMagnet(magnet) };
    }
    if (buf[0] !== 0x64) throw new Error('The indexer returned something that is not a .torrent file');
    return { torrent: buf, infoHash: torrentInfoHash(buf) };
  }
  throw new Error('Too many redirects fetching the torrent');
}

// 40-hex btih from a magnet link; base32 hashes are left to the tag lookup.
export function infoHashFromMagnet(url) {
  const m = /^magnet:.*[?&]xt=urn:btih:([0-9a-f]{40})(?:&|$)/i.exec(String(url || ''));
  return m ? m[1] : '';
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
    // Returns the client's id for the download (info hash, or NZB job id).
    // opts.infoHash: hash the indexer reported, if any. opts.tag: unique label
    // used to find the torrent again when the hash isn't known up front.
    async addTorrent(downloadUrl, opts = {}) {
      if (clientType === 'qbittorrent') {
        await session.request('/api/v2/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        });
        
        const tag = opts.tag || `songarr-${Date.now()}`;
        const t = await fetchTorrent(downloadUrl);
        const form = new FormData();
        if (t.magnet) form.append('urls', t.magnet);
        else form.append('torrents', new Blob([t.torrent], { type: 'application/x-bittorrent' }), 'songarr.torrent');
        form.append('tags', tag);
        const addRes = await session.request('/api/v2/torrents/add', { method: 'POST', body: form });
        if (!addRes.ok) throw new Error(`qBittorrent add failed: ${addRes.status}`);
        // An invalid torrent is still HTTP 200, with "Fails." as the body.
        if ((await addRes.text()).trim() === 'Fails.') throw new Error('qBittorrent rejected the torrent');

        // qBittorrent's add call doesn't return the hash, and adds from a URL
        // finish asynchronously, so look the torrent up by its tag.
        const known = opts.infoHash || t.infoHash;
        if (known) return known.toLowerCase();
        for (let i = 0; i < (opts.lookupAttempts ?? 20); i++) {
          const infoRes = await session.request(`/api/v2/torrents/info?tag=${encodeURIComponent(tag)}`);
          if (infoRes.ok) {
            const list = await infoRes.json();
            if (list.length > 0) return list[0].hash;
          }
          await new Promise(r => setTimeout(r, opts.lookupDelayMs ?? 500));
        }
        throw new Error(`qBittorrent accepted the torrent but it never appeared under tag "${tag}"`);
      }
      
      if (clientType === 'deluge') {
        const t = await fetchTorrent(downloadUrl);
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
          body: JSON.stringify(t.magnet
            ? { method: 'core.add_torrent_magnet', params: [t.magnet, {}], id: 2 }
            : { method: 'core.add_torrent_file', params: ['songarr.torrent', t.torrent.toString('base64'), {}], id: 2 })
        });
        const addJson = await addRes.json();
        if (addJson.error) throw new Error(`Deluge add failed: ${addJson.error.message}`);
        return addJson.result; // Torrent hash
      }
      
      if (clientType === 'transmission') {
        const t = await fetchTorrent(downloadUrl);
        const addRes = await session.request('/transmission/rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'torrent-add',
            arguments: t.magnet ? { filename: t.magnet } : { metainfo: t.torrent.toString('base64') }
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
          isFinished: torrent.progress === 1 || ['uploading', 'pausedUP', 'stoppedUP', 'stalledUP', 'checkingUP', 'forcedUP', 'queuedUP'].includes(torrent.state),
          savePath: torrent.save_path,
          name: torrent.name,
          files,
          ratio: torrent.ratio || 0,
          seedingTime: torrent.seeding_time || 0 // seconds
        };
      }
      
      if (clientType === 'deluge') {
        const statusRes = await session.request('/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'core.get_torrent_status',
            params: [hash, ['progress', 'state', 'save_path', 'files', 'name', 'ratio', 'seeding_time']],
            id: 3
          })
        });
        const statusJson = await statusRes.json();
        // Deluge answers an unknown hash with an empty dict, not an error
        if (statusJson.error || !statusJson.result || Object.keys(statusJson.result).length === 0) return null;
        
        const torrent = statusJson.result;
        return {
          progress: Math.round(torrent.progress),
          isFinished: torrent.progress === 100 || ['Seeding', 'Paused'].includes(torrent.state),
          savePath: torrent.save_path,
          name: torrent.name,
          files: torrent.files ? torrent.files.map(f => f.path) : [],
          ratio: torrent.ratio || 0,
          seedingTime: torrent.seeding_time || 0
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
              fields: ['id', 'hashString', 'name', 'percentDone', 'status', 'files', 'downloadDir', 'uploadRatio', 'secondsSeeding']
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
          files: torrent.files ? torrent.files.map(f => f.name) : [],
          // Transmission reports -1 (no ratio yet) and -2 (infinite)
          ratio: torrent.uploadRatio > 0 ? torrent.uploadRatio : 0,
          seedingTime: torrent.secondsSeeding || 0
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
