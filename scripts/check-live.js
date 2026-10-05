// Live checks that need the internet: yt-dlp/ffmpeg are runnable, Deezer search
// and the Spotify embed scraper still work. Not part of `npm test`, which runs
// offline; run with `npm run check:live`.
import { execFileSync } from 'child_process';
import { binary } from '../server/config.js';
import * as utils from '../server/utils.js';

console.log('=== Songarr live checks ===');
let failed = 0;

async function check(name, fn) {
  try {
    console.log(`  - ${name}: OK (${await fn()})`);
  } catch (e) {
    failed++;
    console.error(`  - ${name}: FAILED (${e.message})`);
  }
}

await check('yt-dlp', () => execFileSync(binary('yt-dlp'), ['--version']).toString().trim());
await check('ffmpeg', () => execFileSync(binary('ffmpeg'), ['-version']).toString().split('\n')[0].trim());
await check('ffprobe', () => execFileSync(binary('ffprobe'), ['-version']).toString().split('\n')[0].trim());

await check('Deezer search', async () => {
  const results = await utils.searchDeezer('Midnight City M83');
  if (results.length === 0) throw new Error('no results');
  return `${results.length} tracks, top: "${results[0].title}" by "${results[0].artist}"`;
});

await check('Spotify embed', async () => {
  const playlist = await utils.parseSpotifyPlaylist('https://open.spotify.com/playlist/3MM2gTiRZMNKQkje0Vpzpd');
  return `${playlist.length} tracks, first: "${playlist[0].title}" by "${playlist[0].artist}"`;
});

console.log(failed ? `=== ${failed} check(s) failed ===` : '=== All live checks passed ===');
process.exit(failed ? 1 : 0);
