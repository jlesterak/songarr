import * as db from './server/db.js';
import * as utils from './server/utils.js';
import * as worker from './server/worker.js';
import { execFileSync } from 'child_process';
import path from 'path';

console.log('=== Songarr Verification Script ===');

// 1. Verify binaries exist and are executable
console.log('\n[1] Verifying Binaries:');
const ytdlp = path.resolve('bin/yt-dlp');
const ffmpeg = path.resolve('bin/ffmpeg');
try {
  const ytdlpVer = execFileSync(ytdlp, ['--version']).toString().trim();
  console.log(`  - yt-dlp: OK (version ${ytdlpVer})`);
  const ffmpegVer = execFileSync(ffmpeg, ['-version']).toString().split('\n')[0].trim();
  console.log(`  - ffmpeg: OK (version ${ffmpegVer})`);
} catch (e) {
  console.error('  - Binary check failed:', e.message);
  process.exit(1);
}

// 2. Initialize Database
console.log('\n[2] Initializing DB:');
try {
  await db.init();
  console.log('  - DB: OK');
} catch (e) {
  console.error('  - DB init failed:', e.message);
  process.exit(1);
}

// 3. Verify Deezer Search and Spotify Scraper
console.log('\n[3] Testing APIs:');
try {
  const results = await utils.searchDeezer('Midnight City M83');
  if (results.length > 0) {
    console.log(`  - Deezer Search: OK (found ${results.length} tracks, top match: "${results[0].title}" by "${results[0].artist}")`);
  } else {
    console.warn('  - Deezer Search: Warning (returned empty results)');
  }
} catch (e) {
  console.error('  - Deezer Search failed:', e.message);
}

try {
  const spotifyUrl = 'https://open.spotify.com/playlist/3MM2gTiRZMNKQkje0Vpzpd';
  const playlist = await utils.parseSpotifyPlaylist(spotifyUrl);
  console.log(`  - Spotify Embed: OK (parsed ${playlist.length} tracks, first track: "${playlist[0].title}" by "${playlist[0].artist}")`);
} catch (e) {
  console.error('  - Spotify Embed failed:', e.message);
}

// 4. Verify Candidate Scoring
console.log('\n[4] Testing Matching & Scoring Logic:');
const mockTrack = {
  title: 'Midnight City',
  artists: ['M83'],
  duration: 243 // seconds (4:03)
};

const candidates = [
  { title: 'M83 - Midnight City (Official Audio)', channel: 'M83 - Topic', duration: 243 }, // perfect match
  { title: 'M83 - Midnight City (Live at Coachella)', channel: 'IndieFest', duration: 320 }, // live version, wrong duration
  { title: 'Midnight City Cover', channel: 'GuitaristJoe', duration: 245 }, // cover
  { title: 'M83 - Midnight City (Official Video)', channel: 'M83', duration: 240 } // good match
];

candidates.forEach(c => {
  const score = worker.scoreCandidate(c, mockTrack, 'M83 Midnight City audio');
  console.log(`  - Score for "${c.title}" (channel: "${c.channel}", dur: ${c.duration}s): ${score}`);
});

console.log('\n=== Verification Completed! ===');
process.exit(0);
