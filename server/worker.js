import path from 'path';
import fs from 'fs/promises';
import * as db from './db.js';
import * as utils from './utils.js';
import * as deemix from './deemix.js';

let isRunning = false;
let workerTimeout = null;

// Helper to sanitize filenames
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

// Album folder as the library names it: "Album (Year)", or just "Album"
// when the release date is unknown.
export function albumFolder(track) {
  const year = (track.releaseDate || '').slice(0, 4);
  const album = sanitizeFilename(track.album);
  return /^\d{4}$/.test(year) ? `${album} (${year})` : album;
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
    console.log('[Worker] Triggering Navidrome library scan...');
    
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

// Variants of a song (extended/remix/instrumental...) that the request didn't
// ask for. Returns the penalty for a candidate title. "Remixed"/"remastered"
// don't match: they describe the original.
const VARIANT_RE = /\b(extended|remix|mix|instrumental|acoustic|karaoke|nightcore|sped up|slowed|reverb|8d)\b/g;
export function variantPenalty(candidateTitle, trackTitle) {
  const wanted = new Set(trackTitle.toLowerCase().match(VARIANT_RE) || []);
  const found = new Set(candidateTitle.toLowerCase().match(VARIANT_RE) || []);
  let penalty = 0;
  for (const v of found) if (!wanted.has(v)) penalty += 40;
  return Math.min(penalty, 80);
}

// Core Matching Logic for YouTube
export function scoreCandidate(candidate, track, queryText) {
  let score = 100;
  
  const durationDiff = candidate.duration > 0 && track.duration > 0 ? Math.abs(candidate.duration - track.duration) : 0;
  if (durationDiff > 30) {
    score -= durationDiff * 2;
  } else {
    score -= durationDiff * 1;
  }
  
  const titleLower = candidate.title.toLowerCase();
  const channelLower = candidate.channel.toLowerCase();
  const trackTitleLower = track.title.toLowerCase();
  const artistLower = track.artists[0]?.toLowerCase() || '';

  const hasTitle = trackTitleLower.split(' ').every(word => {
    if (word.length <= 2) return true;
    return titleLower.includes(word);
  });
  if (!hasTitle) score -= 40;

  if (artistLower) {
    const hasArtist = artistLower.split(' ').every(word => {
      if (word.length <= 2) return true;
      return titleLower.includes(word) || channelLower.includes(word);
    });
    if (!hasArtist) score -= 30;
  }

  if (channelLower.includes('topic') || channelLower.endsWith('- topic')) {
    score += 25;
  }

  if (titleLower.includes('official audio') || titleLower.includes('audio')) {
    score += 15;
  }

  const isLiveRequested = trackTitleLower.includes('live');
  const isCoverRequested = trackTitleLower.includes('cover');

  if (!isLiveRequested && (titleLower.includes('live at') || titleLower.includes('live concert') || titleLower.includes('live performance') || titleLower.includes(' live '))) {
    score -= 60;
  }
  if (!isCoverRequested && titleLower.includes('cover') && !titleLower.includes('album cover')) {
    score -= 60;
  }
  score -= variantPenalty(titleLower, trackTitleLower);

  return score;
}

// Quality Rules Resolver
export function getTrackQualityRule(track, settings) {
  const qualityRules = settings.qualityRules || [];
  
  // 1. Check playlist rules
  const playlists = db.getPlaylists();
  const trackPlaylists = playlists.filter(pl => pl.trackIds.includes(track.id));
  for (const pl of trackPlaylists) {
    const plRule = qualityRules.find(r => r.type === 'playlist' && r.name.toLowerCase() === pl.name.toLowerCase());
    if (plRule) return plRule;
  }
  
  // 2. Check artist rules
  for (const artist of track.artists) {
    const artistRule = qualityRules.find(r => r.type === 'artist' && r.name.toLowerCase() === artist.toLowerCase());
    if (artistRule) return artistRule;
  }
  
  return null;
}

// Score Torrent Candidates
export function scoreTorrentCandidate(torrent, track, targetFormat) {
  let score = 100;
  const titleLower = torrent.title.toLowerCase();
  const trackTitleLower = track.title.toLowerCase();
  const artistLower = track.artists[0]?.toLowerCase() || '';
  
  if (torrent.seeders === 0) {
    score -= 120;
  } else {
    score += Math.min(torrent.seeders, 20);
  }
  
  const titleWords = trackTitleLower.split(' ').filter(w => w.length > 2);
  const artistWords = artistLower.split(' ').filter(w => w.length > 2);
  
  const hasTitleWords = titleWords.every(word => titleLower.includes(word));
  const hasArtistWords = artistWords.every(word => titleLower.includes(word));
  
  if (!hasTitleWords) score -= 40;
  if (!hasArtistWords) score -= 30;
  
  if (targetFormat === 'flac') {
    if (titleLower.includes('flac') || titleLower.includes('lossless')) {
      score += 60;
    } else if (titleLower.includes('mp3') || titleLower.includes('320')) {
      score -= 50;
    }
  } else {
    if (titleLower.includes('mp3') || titleLower.includes('320')) {
      score += 30;
    } else if (titleLower.includes('flac')) {
      score -= 20;
    }
  }
  
  if (!trackTitleLower.includes('live') && (titleLower.includes('live at') || titleLower.includes('live concert') || titleLower.includes(' live '))) {
    score -= 60;
  }
  if (!trackTitleLower.includes('cover') && titleLower.includes('cover') && !titleLower.includes('album cover')) {
    score -= 60;
  }
  // Torrent results carry no duration; the variant check stands in for it.
  score -= variantPenalty(titleLower, trackTitleLower);

  return score;
}

// Rewrite a download client's save path into the path Songarr sees.
export function mapRemotePath(remote, settings) {
  const from = (settings.downloadPathRemote || '').replace(/\/+$/, '');
  const to = (settings.downloadPathLocal || '').replace(/\/+$/, '');
  if (!from || !to || !remote) return remote;
  if (remote === from) return to;
  if (remote.startsWith(from + '/')) return to + remote.slice(from.length);
  return remote;
}

// node-id3 only understands MP3; writing an ID3 header into FLAC/M4A/OGG
// corrupts them, and files from torrents usually arrive tagged anyway.
async function tagIfMp3(filePath, track) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') {
    console.log(`[Worker] Not an MP3, keeping existing tags: ${filePath}`);
    return true;
  }
  return utils.tagAudioFile(filePath, track);
}

// Put a downloaded file into the library. Hardlinks keep a seeding torrent's
// data intact without using extra space, but share the inode: any file we are
// about to edit (MP3s get ID3 tags written in place) must be a real copy, or
// the edit would corrupt the torrent's data. Cross-filesystem links fall back
// to a copy.
export async function linkOrCopy(src, dest, settings, { willModify = false } = {}) {
  await fs.rm(dest, { force: true });
  if (settings.importMode !== 'copy' && !willModify) {
    try {
      await fs.link(src, dest);
      return 'hardlink';
    } catch (err) {
      if (!['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP'].includes(err.code)) throw err;
      console.log(`[Worker] Hardlink not possible (${err.code}), copying instead: ${dest}`);
    }
  }
  await fs.copyFile(src, dest);
  return 'copy';
}

// Has a seeding torrent reached its ratio or seed-time limit? No limits set
// means it seeds until someone removes it.
// True when a downloading torrent has made no progress for the stall timeout.
export function isStalled(track, progress, settings, now = Date.now()) {
  const minutes = Number(settings.stallTimeoutMinutes ?? 30);
  if (!(minutes > 0)) return false;
  if (progress > (track.lastProgress ?? 0)) return false;
  const since = Date.parse(track.lastProgressAt || track.snatchedAt || '') || now;
  return now - since > minutes * 60000;
}

export function seedLimitReached(info, settings) {
  const ratioLimit = Number(settings.seedRatioLimit) || 0;
  const hoursLimit = Number(settings.seedTimeLimitHours) || 0;
  if (ratioLimit > 0 && (info.ratio || 0) >= ratioLimit) return true;
  if (hoursLimit > 0 && (info.seedingTime || 0) >= hoursLimit * 3600) return true;
  return false;
}

// Usenet has nothing to seed; everything else seeds if the setting is on.
function keepsSeeding(settings) {
  return settings.seedAfterImport !== false && settings.torrentClient !== 'sabnzbd';
}

// Find all audio files recursively
async function findAudioFiles(dir) {
  let results = [];
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const file of list) {
      const res = path.resolve(dir, file.name);
      if (file.isDirectory()) {
        results = results.concat(await findAudioFiles(res));
      } else {
        const ext = path.extname(file.name).toLowerCase();
        if (['.mp3', '.m4a', '.flac', '.wav', '.ogg'].includes(ext)) {
          results.push(res);
        }
      }
    }
  } catch (e) {
    // Ignore read errors
  }
  return results;
}

// Score a single audio file in a downloaded album/folder to find the target track
async function scoreAudioFile(filePath, track) {
  let score = 100;
  const fileNameLower = path.basename(filePath).toLowerCase();
  const trackTitleLower = track.title.toLowerCase();
  
  const duration = await utils.getFileDuration(filePath);
  if (duration && track.duration) {
    const diff = Math.abs(duration - track.duration);
    score -= diff * 3;
  } else {
    score -= 50;
  }
  
  const words = trackTitleLower.split(' ').filter(w => w.length > 2);
  if (words.length > 0) {
    const matchCount = words.filter(word => fileNameLower.includes(word)).length;
    score += (matchCount / words.length) * 40;
  }
  
  return score;
}

// Poller for active downloads
async function pollActiveDownloads(settings) {
  const tracks = db.getTracks();
  const activeTracks = tracks.filter(t => ['snatched', 'downloading'].includes(t.status) && t.torrentHash);
  // Seeding torrents only need checking when there is a limit to enforce
  const hasSeedLimit = Number(settings.seedRatioLimit) > 0 || Number(settings.seedTimeLimitHours) > 0;
  const seedingTracks = hasSeedLimit ? tracks.filter(t => t.status === 'imported' && t.seeding && t.torrentHash) : [];
  
  if (activeTracks.length === 0 && seedingTracks.length === 0) return;
  
  const client = utils.getDownloadClient(settings);
  
  for (const track of seedingTracks) {
    try {
      const info = await client.getProgress(track.torrentHash);
      if (!info) {
        console.log(`[Worker] Seeding torrent for "${track.title}" is gone from the client.`);
        await db.updateTrack(track.id, { seeding: false });
      } else if (seedLimitReached(info, settings)) {
        console.log(`[Worker] "${track.title}" reached its seed limit (ratio ${info.ratio}, ${Math.round(info.seedingTime / 3600)}h). Removing torrent and its download files...`);
        await client.removeTorrent(track.torrentHash, true);
        await db.updateTrack(track.id, { seeding: false });
      }
    } catch (err) {
      // Leave it seeding and try again next cycle
      console.error(`[Worker] Failed to check seeding torrent for "${track.title}":`, err.message);
    }
  }
  
  if (activeTracks.length === 0) return;
  console.log(`[Worker] Polling progress for ${activeTracks.length} active torrent downloads...`);
  
  for (const track of activeTracks) {
    try {
      let progressInfo;
      try {
        progressInfo = await client.getProgress(track.torrentHash);
      } catch (err) {
        // Client unreachable (VPN reconnect, restart): not the download's fault. Retry next cycle.
        console.warn(`[Worker] Couldn't reach ${settings.torrentClient} for "${track.title}" (${err.message}); will retry.`);
        continue;
      }
      if (!progressInfo) {
        console.warn(`[Worker] Snatched torrent for track "${track.title}" not found in client. Resetting status to wanted.`);
        await db.updateTrack(track.id, { status: 'wanted', torrentHash: null, error: 'Torrent vanished from client' });
        continue;
      }
      
      console.log(`[Worker] Track "${track.title}" progress: ${progressInfo.progress}% (${progressInfo.isFinished ? 'Finished' : 'Downloading'})`);

      if (!progressInfo.isFinished) {
        if (!track.snatchedAt && !track.lastProgressAt) {
          // Snatched before stall tracking existed: start its clock now.
          await db.updateTrack(track.id, { lastProgressAt: new Date().toISOString() });
          continue;
        }
        if (isStalled(track, progressInfo.progress, settings)) {
          console.warn(`[Worker] "${track.title}": no progress for ${settings.stallTimeoutMinutes} min on "${track.torrentName}". Dropping it and trying the next candidate.`);
          await client.removeTorrent(track.torrentHash, true);
          await db.updateTrack(track.id, {
            status: 'wanted',
            torrentHash: null,
            triedTorrents: [...(track.triedTorrents || []), track.torrentName],
            error: `Stalled: ${track.torrentName}`
          });
          continue;
        }
        if (progressInfo.progress > (track.lastProgress ?? 0)) {
          await db.updateTrack(track.id, { lastProgress: progressInfo.progress, lastProgressAt: new Date().toISOString() });
        }
      }
      
      if (track.status === 'snatched' && progressInfo.progress > 0) {
        await db.updateTrack(track.id, { status: 'downloading' });
      }
      
      if (progressInfo.isFinished) {
        if (removedFromQueue(track)) {
          await client.removeTorrent(track.torrentHash, true);
          continue;
        }
        console.log(`[Worker] Torrent finished for track: "${track.title}". Starting post-processing...`);
        await db.updateTrack(track.id, { status: 'downloaded' });
        
        const quality = track.targetQuality || settings.audioQuality || '320k';
        const artistDir = sanitizeFilename(track.artists[0]);
        const albumDir = albumFolder(track);
        const targetAlbumDir = path.join(settings.libraryPath, artistDir, albumDir);
        const trackNum = track.trackNumber ? String(track.trackNumber).padStart(2, '0') : '01';
        
        if (!progressInfo.savePath) {
          throw new Error('No download save path returned by client');
        }
        const savePath = mapRemotePath(progressInfo.savePath, settings);
        let sourceDir = progressInfo.name ? path.join(savePath, progressInfo.name) : savePath;
        const dirExists = await fs.stat(sourceDir).then(s => s.isDirectory()).catch(() => false);
        if (!dirExists) {
          sourceDir = savePath;
        }
        
        console.log(`[Worker] Scanning download directory for audio files: ${sourceDir}`);
        const audioFiles = await findAudioFiles(sourceDir);
        if (audioFiles.length === 0) {
          throw new Error(`No audio files found in downloaded torrent path: ${sourceDir}`);
        }
        
        const scoredFiles = [];
        for (const file of audioFiles) {
          scoredFiles.push({ file, score: await scoreAudioFile(file, track) });
        }
        scoredFiles.sort((a, b) => b.score - a.score);
        const bestFile = scoredFiles[0].file;
        // Keep the file's real container: a FLAC renamed to .mp3 plays badly
        // and then gets an ID3 header written into it.
        const ext = path.extname(bestFile).toLowerCase();
        const destFile = path.join(targetAlbumDir, `${trackNum} - ${sanitizeFilename(track.title)}${ext}`);
        await fs.mkdir(targetAlbumDir, { recursive: true });
        
        // MP3s get tagged below, so they must be copies, not links
        const willModify = ext === '.mp3';
        if (settings.albumDownloadMode === 'single') {
          console.log(`[Worker] Selected single track file: "${bestFile}" with score ${scoredFiles[0].score}`);
          await linkOrCopy(bestFile, destFile, settings, { willModify });
        } else {
          console.log(`[Worker] Album mode: importing all ${audioFiles.length} audio files to album folder...`);
          for (const file of audioFiles) {
            const isBest = file === bestFile;
            const target = isBest ? destFile : path.join(targetAlbumDir, sanitizeFilename(path.basename(file)));
            await linkOrCopy(file, target, settings, { willModify: isBest && willModify });
          }
        }
        
        console.log(`[Worker] Tagging file: ${destFile}`);
        const tagged = await tagIfMp3(destFile, track);
        
        const seeding = keepsSeeding(settings);
        await db.updateTrack(track.id, {
          status: 'imported',
          source: 'torrent',
          filePath: destFile,
          bitrate: quality,
          format: ext.slice(1),
          seeding,
          error: tagged ? null : 'Tagging failed, but audio downloaded'
        });
        
        console.log(`[Worker] Successfully imported: ${destFile}`);
        
        const playlists = db.getPlaylists();
        for (const pl of playlists) {
          if (pl.trackIds.includes(track.id)) {
            await regenerateM3UPlaylist(pl);
          }
        }
        
        if (seeding) {
          console.log(`[Worker] Leaving torrent ${track.torrentHash} seeding.`);
        } else {
          console.log(`[Worker] Removing torrent ${track.torrentHash} from client and cleaning up download files...`);
          await client.removeTorrent(track.torrentHash, true);
        }
      }
    } catch (err) {
      console.error(`[Worker] Failed to process active torrent download for "${track.title}":`, err.message);
      await db.updateTrack(track.id, { status: 'failed', error: err.message || 'Torrent processing error' });
    }
  }
}

// Direct YouTube Downloader Helper
// True once the track was removed from the queue (e.g. "clear queue") while
// the worker was busy with it; in-flight work must then not land anywhere.
function removedFromQueue(track) {
  return !db.getTrack(track.id);
}

// deemix: queue the exact Deezer track. A failure marks the track deemixTried
// so this and later cycles fall through to the torrent/YouTube paths.
async function startDeemix(track, settings, format) {
  const bitrate = deemix.deemixBitrate(format);
  let uuid = await deemix.addTrack(settings, track.id, bitrate);
  // deemix keeps finished/failed items, and a re-add of the same track just
  // finds the old one. Drop a stale item and add it once more.
  const item = await deemix.getItem(settings, uuid).catch(() => null);
  if (item && await deemixItemStale(item, settings)) {
    console.log(`[Worker] Dropping stale deemix item ${uuid} (${item.status}) and re-adding.`);
    await deemix.removeItem(settings, uuid);
    uuid = await deemix.addTrack(settings, track.id, bitrate);
  }
  console.log(`[Worker] Queued "${track.title}" in deemix (${uuid}).`);
  await db.updateTrack(track.id, {
    status: 'snatched',
    error: null,
    deemixUuid: uuid,
    snatchedAt: new Date().toISOString()
  });
}

async function deemixItemStale(item, settings) {
  if (['inQueue', 'downloading'].includes(item.status)) return false;
  const remote = item.files?.find(f => f.path)?.path;
  if (!remote) return true; // failed, or finished without a file
  const local = mapRemotePath(remote, { downloadPathRemote: settings.deemixPathRemote, downloadPathLocal: settings.deemixPathLocal });
  return !(await fs.access(local).then(() => true, () => false));
}

async function deemixFailed(track, settings, reason) {
  console.warn(`[Worker] deemix failed for "${track.title}": ${reason}. Falling back.`);
  await deemix.removeItem(settings, track.deemixUuid).catch(() => {});
  await db.updateTrack(track.id, { status: 'wanted', deemixUuid: null, deemixTried: true, error: `deemix: ${reason}` });
}

// Move a finished file into the library. deemix doesn't seed, so nothing needs
// the download copy afterwards.
const moveFile = deemix.copyOrMove;

async function pollDeemix(settings) {
  const tracks = db.getTracks().filter(t => ['snatched', 'downloading'].includes(t.status) && t.deemixUuid);
  for (const track of tracks) {
    let item;
    try {
      item = await deemix.getItem(settings, track.deemixUuid);
    } catch (err) {
      console.warn(`[Worker] Couldn't reach deemix for "${track.title}" (${err.message}); will retry.`);
      continue;
    }
    try {
      if (!item) {
        await deemixFailed(track, settings, 'item vanished from the deemix queue');
        continue;
      }
      if (item.status === 'inQueue' || item.status === 'downloading') {
        if (track.status === 'snatched' && item.status === 'downloading') {
          await db.updateTrack(track.id, { status: 'downloading' });
        }
        continue;
      }
      const remote = item.files?.find(f => f.path)?.path;
      if (!remote) {
        const why = item.errors?.[0]?.message || `status ${item.status}, no file`;
        await deemixFailed(track, settings, why);
        continue;
      }
      const src = mapRemotePath(remote, { downloadPathRemote: settings.deemixPathRemote, downloadPathLocal: settings.deemixPathLocal });
      const ext = path.extname(src).toLowerCase();
      const trackNum = track.trackNumber ? String(track.trackNumber).padStart(2, '0') : '01';
      const targetAlbumDir = path.join(settings.libraryPath, sanitizeFilename(track.artists[0]), albumFolder(track));
      const destFile = path.join(targetAlbumDir, `${trackNum} - ${sanitizeFilename(track.title)}${ext}`);
      await fs.mkdir(targetAlbumDir, { recursive: true });
      await moveFile(src, destFile);
      await deemix.moveExtras(src, destFile, settings.deemixPathLocal);
      // deemix already wrote full Deezer tags; no retagging.
      await db.updateTrack(track.id, {
        status: 'imported',
        source: 'deemix',
        filePath: destFile,
        format: ext.slice(1),
        bitrate: ext === '.flac' ? 'lossless' : '320k',
        error: null
      });
      await deemix.removeItem(settings, track.deemixUuid).catch(() => {});
      console.log(`[Worker] Imported from deemix: ${destFile}`);
      for (const pl of db.getPlaylists()) {
        if (pl.trackIds.includes(track.id)) await regenerateM3UPlaylist(pl);
      }
    } catch (err) {
      await deemixFailed(track, settings, err.message);
    }
  }
}

async function downloadDirectFromYouTube(track, settings, format, quality) {
  if (removedFromQueue(track)) return;
  try {
    const artist = track.artists[0];
    const searchTerms = `${artist} ${track.title}`;
    const queryText = `${searchTerms} audio`;
    
    console.log(`[Worker] Searching YouTube for: "${queryText}"`);
    const candidates = await utils.searchYouTube(queryText, 5);
    
    if (candidates.length === 0) {
      throw new Error('No candidates found on YouTube');
    }

    const scored = candidates.map(c => ({
      candidate: c,
      score: scoreCandidate(c, track, queryText)
    })).sort((a, b) => b.score - a.score);

    const bestMatch = scored[0];
    console.log('[Worker] YouTube search results:');
    scored.forEach(s => {
      console.log(`  - [Score: ${s.score}] "${s.candidate.title}" by ${s.candidate.channel} (${s.candidate.duration}s)`);
    });

    if (bestMatch.score < 20) {
      console.warn(`[Worker] Best match score is very low (${bestMatch.score}). Falling back to top search result.`);
    }

    const chosenVideo = bestMatch.candidate;
    console.log(`[Worker] Selected video: "${chosenVideo.title}" (${chosenVideo.url})`);

    await db.updateTrack(track.id, { status: 'downloading' });

    const artistDir = sanitizeFilename(track.artists[0]);
    const albumDir = albumFolder(track);
    const trackNum = track.trackNumber ? String(track.trackNumber).padStart(2, '0') : '01';
    
    const actualFormat = format === 'flac' ? 'mp3' : format;
    const actualQuality = format === 'flac' ? '320k' : quality;
    
    const fileBase = `${trackNum} - ${sanitizeFilename(track.title)}.${actualFormat}`;
    const destFile = path.join(settings.libraryPath, artistDir, albumDir, fileBase);

    console.log(`[Worker] Downloading audio to: ${destFile}`);
    await utils.downloadTrackAudio(chosenVideo.url, destFile, actualFormat, actualQuality);

    if (removedFromQueue(track)) {
      console.log(`[Worker] "${track.title}" was removed from the queue mid-download; discarding ${destFile}`);
      await fs.rm(destFile, { force: true });
      await fs.rmdir(path.dirname(destFile)).catch(() => {}); // only if now empty
      return;
    }

    await db.updateTrack(track.id, { status: 'downloaded' });

    console.log('[Worker] Tagging file with metadata...');
    const tagged = await utils.tagAudioFile(destFile, track);
    
    await db.updateTrack(track.id, {
      status: 'imported',
      source: 'youtube',
      torrentHash: null,
      torrentName: null,
      seeding: false,
      filePath: destFile,
      bitrate: actualQuality,
      format: actualFormat,
      error: tagged ? null : 'Tagging failed, but audio downloaded'
    });

    console.log(`[Worker] Success! Track imported: ${destFile}`);

    const playlists = db.getPlaylists();
    for (const pl of playlists) {
      if (pl.trackIds.includes(track.id)) {
        await regenerateM3UPlaylist(pl);
      }
    }
  } catch (err) {
    console.error(`[Worker] YouTube direct download failed for track ${track.title}:`, err);
    await db.updateTrack(track.id, {
      status: 'failed',
      error: err.message || 'Unknown direct download error'
    });
  }
}

export async function processQueue() {
  if (isRunning) return;
  isRunning = true;
  console.log('[Worker] Starting queue processor...');

  try {
    const settings = db.getSettings();
    
    // 1. First poll active torrent/nzb downloads
    await pollActiveDownloads(settings);
    if (settings.deemixUrl) await pollDeemix(settings);
    
    // 2. Process wanted tracks
    const tracks = db.getTracks();
    const wantedTracks = tracks.filter(t => t.status === 'wanted');
    
    if (wantedTracks.length > 0) {
      console.log(`[Worker] Found ${wantedTracks.length} wanted tracks to process.`);

      for (const track of wantedTracks) {
        if (removedFromQueue(track)) continue;
        console.log(`[Worker] Processing track: ${track.artists.join(', ')} - ${track.title}`);
        
        const rule = getTrackQualityRule(track, settings);
        const format = rule ? rule.format : (settings.audioFormat || 'mp3');
        const quality = rule ? rule.quality : (settings.audioQuality || '320k');
        const method = settings.downloadMethod || 'direct';

        if (settings.deemixUrl && !track.deemixTried) {
          try {
            await startDeemix(track, settings, format);
            continue;
          } catch (err) {
            console.warn(`[Worker] deemix couldn't take "${track.title}": ${err.message}. Falling back.`);
            await db.updateTrack(track.id, { deemixTried: true, error: `deemix: ${err.message}` });
          }
        }
        
        if (method === 'torrent' && settings.prowlarrUrl) {
          try {
            await db.updateTrack(track.id, {
              status: 'snatched',
              error: null,
              targetFormat: format,
              targetQuality: quality
            });
            
            const query = `${track.artists[0]} - ${track.title}`;
            console.log(`[Worker] Searching torrent indexers for: "${query}"`);
            const tried = track.triedTorrents || [];
            if (tried.length >= (Number(settings.maxTorrentAttempts) || 3)) {
              throw new Error(`${tried.length} torrents stalled`);
            }
            const candidates = (await utils.searchIndexer(query, settings))
              .filter(c => !tried.includes(c.title));
            
            if (candidates.length === 0) {
              throw new Error(tried.length ? 'No untried torrent candidates left' : 'No torrent candidates found');
            }
            
            const scored = candidates.map(c => ({
              candidate: c,
              score: scoreTorrentCandidate(c, track, format)
            })).sort((a, b) => b.score - a.score);
            
            console.log('[Worker] Torrent candidates results:');
            scored.forEach(s => {
              console.log(`  - [Score: ${s.score}] "${s.candidate.title}" (Seeders: ${s.candidate.seeders}, Size: ${(s.candidate.size / (1024*1024)).toFixed(1)}MB, Indexer: ${s.candidate.indexer})`);
            });
            
            const best = scored[0];
            if (best.score < 20) {
              console.warn(`[Worker] Best torrent score is very low (${best.score}). Proceeding anyway.`);
            }
            
            const client = utils.getDownloadClient(settings);
            console.log(`[Worker] Snatched torrent: "${best.candidate.title}" via ${settings.torrentClient}`);
            
            const hash = await client.addTorrent(best.candidate.downloadUrl, {
              infoHash: best.candidate.infoHash,
              tag: `songarr-${track.id}`
            });
            if (!hash) {
              throw new Error(`${settings.torrentClient} did not return an id for the added download`);
            }
            if (removedFromQueue(track)) {
              console.log(`[Worker] "${track.title}" was removed from the queue mid-snatch; removing its torrent.`);
              await client.removeTorrent(hash, true);
              continue;
            }
            await db.updateTrack(track.id, {
              torrentHash: hash,
              torrentName: best.candidate.title,
              snatchedAt: new Date().toISOString(),
              lastProgress: 0,
              lastProgressAt: null
            });
          } catch (err) {
            console.error(`[Worker] Failed to snatch torrent for ${track.title}:`, err.message);
            console.log(`[Worker] Falling back to YouTube direct download for "${track.title}"...`);
            await downloadDirectFromYouTube(track, settings, format, quality);
          }
        } else {
          await downloadDirectFromYouTube(track, settings, format, quality);
        }
      }
    } else {
      console.log('[Worker] No wanted tracks in queue.');
    }

    triggerNavidromeScan().catch(err => console.error(err));

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

