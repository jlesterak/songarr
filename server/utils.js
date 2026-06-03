import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { promisify } from 'util';
import nodeID3 from 'node-id3';

const execFileAsync = promisify(execFile);

const YTDLP_PATH = path.resolve('bin/yt-dlp');
const FFMPEG_PATH = path.resolve('bin/ffmpeg');

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
    
    // Extract JSON payload from Spotify embed
    // They store playlist state inside a <script id="initial-state" type="application/json"> or similar script tag.
    // Or sometimes in a __NEXT_DATA__ block or custom state json.
    const jsonMatch = html.match(/<script id="initial-state" type="application\/json">([\s\S]*?)<\/script>/);
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
      throw new Error('Could not find playlist state in Spotify embed page');
    }
    
    const state = JSON.parse(jsonMatch[1]);
    
    // Parse tracks from state object
    // Path: state.fetchResult.data.playlist
    const playlistData = state.fetchResult?.data?.playlist;
    if (!playlistData || !playlistData.tracks) {
      // Alternative path structure
      const alternativeTracks = [];
      // Search recursively in state for tracks
      return alternativeTracks;
    }
    
    const items = playlistData.tracks.items || [];
    return items.map(item => {
      const track = item.track;
      return {
        title: track.name,
        artist: track.artists[0]?.name || 'Unknown Artist',
        artists: track.artists.map(a => a.name),
        album: track.album?.name || '',
        durationMs: track.duration_ms || 0,
        spotifyId: track.id
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
