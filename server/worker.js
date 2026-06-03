import path from 'path';
import fs from 'fs/promises';
import * as db from './db.js';
import * as utils from './utils.js';

let isRunning = false;
let workerTimeout = null;

// Helper to sanitize filenames
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

// Generate M3U playlist file
async function regenerateM3UPlaylist(playlist) {
  try {
    const settings = db.getSettings();
    const playlistDir = path.join(settings.libraryPath, 'Playlists');
    await fs.mkdir(playlistDir, { recursive: true });
    
    const m3uFile = path.join(playlistDir, `${sanitizeFilename(playlist.name)}.m3u`);
    let content = '#EXTM3U\n\n';
    
    for (const track of playlist.tracks) {
      if (track.status === 'imported' && track.filePath) {
        // Use relative path from the Playlists folder to the track file
        const relativePath = path.relative(playlistDir, track.filePath);
        content += `#EXTINF:${track.duration || 0},${track.artists.join(', ')} - ${track.title}\n`;
        content += `${relativePath}\n\n`;
      }
    }
    
    await fs.writeFile(m3uFile, content, 'utf-8');
    console.log(`[Worker] Playlist ${playlist.name} M3U regenerated.`);
  } catch (err) {
    console.error(`[Worker] Failed to generate M3U for ${playlist.name}:`, err);
  }
}

// Navidrome library scan trigger
async function triggerNavidromeScan() {
  const settings = db.getSettings();
  if (!settings.navidromeUrl) return;

  try {
    let url = settings.navidromeUrl.replace(/\/$/, '');
    // Subsonic API call
    // If user provided a Subsonic URL or Navidrome URL, trigger scan
    // Path: /rest/startScan.view or /api/v1/scan
    console.log('[Worker] Triggering Navidrome library scan...');
    
    // We try Subsonic startScan.view first
    // Needs user/token
    const subsonicUrl = `${url}/rest/startScan.view?u=${encodeURIComponent(settings.navidromeUsername || 'admin')}&t=${settings.navidromeToken}&s=songarr&v=1.16.1&c=songarr&f=json`;
    const res = await fetch(subsonicUrl);
    if (res.ok) {
      const data = await res.json();
      console.log('[Worker] Navidrome scan response:', data);
    } else {
      console.error('[Worker] Navidrome scan trigger failed status:', res.status);
    }
  } catch (err) {
    console.error('[Worker] Failed to trigger Navidrome scan:', err.message);
  }
}

// Core Matching Logic
export function scoreCandidate(candidate, track, queryText) {
  let score = 100;
  
  // 1. Duration difference check (extremely important)
  const durationDiff = Math.abs(candidate.duration - track.duration);
  if (durationDiff > 30) {
    score -= durationDiff * 2; // Penalize heavily for major duration differences
  } else {
    score -= durationDiff * 1; // Minor penalty
  }
  
  const titleLower = candidate.title.toLowerCase();
  const channelLower = candidate.channel.toLowerCase();
  const trackTitleLower = track.title.toLowerCase();
  const artistLower = track.artists[0]?.toLowerCase() || '';

  // 2. Title match check
  const hasTitle = trackTitleLower.split(' ').every(word => {
    // skip tiny words
    if (word.length <= 2) return true;
    return titleLower.includes(word);
  });
  if (!hasTitle) score -= 40;

  // 3. Artist match check
  if (artistLower) {
    const hasArtist = artistLower.split(' ').every(word => {
      if (word.length <= 2) return true;
      return titleLower.includes(word) || channelLower.includes(word);
    });
    if (!hasArtist) score -= 30;
  }

  // 4. Boost label uploads (Topic channels are official high quality audio uploads)
  if (channelLower.includes('topic') || channelLower.endsWith('- topic')) {
    score += 25;
  }

  // 5. Boost "audio" / "official audio" uploads
  if (titleLower.includes('official audio') || titleLower.includes('audio')) {
    score += 15;
  }

  // 6. Penalize live, cover, remix (unless requested in the title)
  const isLiveRequested = trackTitleLower.includes('live');
  const isCoverRequested = trackTitleLower.includes('cover');
  const isRemixRequested = trackTitleLower.includes('remix');

  if (!isLiveRequested && (titleLower.includes('live at') || titleLower.includes('live concert') || titleLower.includes('live performance') || titleLower.includes(' live '))) {
    score -= 60;
  }
  if (!isCoverRequested && titleLower.includes('cover') && !titleLower.includes('album cover')) {
    score -= 60;
  }
  if (!isRemixRequested && titleLower.includes('remix') && !titleLower.includes('remixed')) {
    score -= 40;
  }

  return score;
}

export async function processQueue() {
  if (isRunning) return;
  isRunning = true;
  console.log('[Worker] Starting queue processor...');

  try {
    const tracks = db.getTracks();
    const wantedTracks = tracks.filter(t => t.status === 'wanted');
    
    if (wantedTracks.length === 0) {
      console.log('[Worker] No wanted tracks in queue.');
      isRunning = false;
      return;
    }
    
    const settings = db.getSettings();
    console.log(`[Worker] Found ${wantedTracks.length} tracks to process.`);

    for (const track of wantedTracks) {
      console.log(`[Worker] Processing track: ${track.artists.join(', ')} - ${track.title}`);
      
      // Update status to snatched
      await db.updateTrack(track.id, { status: 'snatched', error: null });

      try {
        // Search YouTube for candidates
        const artist = track.artists[0];
        const searchTerms = `${artist} ${track.title}`;
        const queryText = `${searchTerms} audio`;
        
        console.log(`[Worker] Searching YouTube for: "${queryText}"`);
        const candidates = await utils.searchYouTube(queryText, 5);
        
        if (candidates.length === 0) {
          throw new Error('No candidates found on YouTube');
        }

        // Score candidates and choose best
        const scored = candidates.map(c => ({
          candidate: c,
          score: scoreCandidate(c, track, queryText)
        })).sort((a, b) => b.score - a.score);

        const bestMatch = scored[0];
        console.log('[Worker] Candidate search results:');
        scored.forEach(s => {
          console.log(`  - [Score: ${s.score}] "${s.candidate.title}" by ${s.candidate.channel} (${s.candidate.duration}s)`);
        });

        if (bestMatch.score < 20) {
          console.warn(`[Worker] Best match score is very low (${bestMatch.score}). Falling back to top search result.`);
        }

        const chosenVideo = bestMatch.candidate;
        console.log(`[Worker] Selected video: "${chosenVideo.title}" (${chosenVideo.url})`);

        // Update status to downloading
        await db.updateTrack(track.id, { status: 'downloading' });

        // Define file path
        const format = settings.audioFormat || 'mp3';
        const quality = settings.audioQuality || '320k';
        
        const artistDir = sanitizeFilename(track.artists[0]);
        const albumDir = sanitizeFilename(track.album);
        
        // Track number formatting
        const trackNum = track.trackNumber ? String(track.trackNumber).padStart(2, '0') : '01';
        const fileBase = `${trackNum} - ${sanitizeFilename(track.title)}.${format}`;
        
        const destFile = path.join(settings.libraryPath, artistDir, albumDir, fileBase);

        console.log(`[Worker] Downloading audio to: ${destFile}`);
        await utils.downloadTrackAudio(chosenVideo.url, destFile, format, quality);

        // Update status to downloaded
        await db.updateTrack(track.id, { status: 'downloaded' });

        // Write ID3 metadata
        console.log('[Worker] Tagging file with metadata...');
        const tagged = await utils.tagAudioFile(destFile, track);
        
        // Update track record
        await db.updateTrack(track.id, {
          status: 'imported',
          filePath: destFile,
          bitrate: quality,
          format: format,
          error: tagged ? null : 'Tagging failed, but audio downloaded'
        });

        console.log(`[Worker] Success! Track imported: ${destFile}`);

        // Regenerate affected playlists
        const playlists = db.getPlaylists();
        for (const pl of playlists) {
          if (pl.trackIds.includes(track.id)) {
            await regenerateM3UPlaylist(pl);
          }
        }

      } catch (err) {
        console.error(`[Worker] Failed to process track ${track.title}:`, err);
        await db.updateTrack(track.id, {
          status: 'failed',
          error: err.message || 'Unknown download error'
        });
      }
    }

    // Trigger Navidrome library refresh if configured
    await triggerNavidromeScan();

  } catch (err) {
    console.error('[Worker] Fatal error in queue loop:', err);
  } finally {
    isRunning = false;
    console.log('[Worker] Queue processor cycle finished.');
  }
}

// Start periodic worker loop
export function startWorker() {
  if (workerTimeout) return;
  
  const tick = async () => {
    const settings = db.getSettings();
    if (settings.autoDownload) {
      await processQueue();
    }
    
    const intervalMs = (settings.downloadInterval || 5) * 60 * 1000;
    workerTimeout = setTimeout(tick, intervalMs);
  };
  
  tick();
  console.log('[Worker] Background worker scheduled.');
}

// Stop periodic worker loop
export function stopWorker() {
  if (workerTimeout) {
    clearTimeout(workerTimeout);
    workerTimeout = null;
    console.log('[Worker] Background worker stopped.');
  }
}
