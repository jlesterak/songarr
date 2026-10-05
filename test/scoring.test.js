import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const { scoreCandidate, scoreTorrentCandidate, mapRemotePath, seedLimitReached } = await import('../server/worker.js');
const { audioQualityArg, infoHashFromMagnet } = await import('../server/utils.js');
after(() => env.cleanup());

const track = { title: 'Midnight City', artists: ['M83'], duration: 243 };

test('YouTube scoring prefers the Topic upload over video, cover and live', () => {
  const score = c => scoreCandidate(c, track, 'M83 Midnight City audio');
  const topic = score({ title: 'M83 - Midnight City (Official Audio)', channel: 'M83 - Topic', duration: 243 });
  const video = score({ title: 'M83 - Midnight City (Official Video)', channel: 'M83', duration: 240 });
  const cover = score({ title: 'Midnight City Cover', channel: 'GuitaristJoe', duration: 245 });
  const live = score({ title: 'M83 - Midnight City (Live at Coachella)', channel: 'IndieFest', duration: 320 });
  assert.ok(topic > video, `topic ${topic} > video ${video}`);
  assert.ok(video > cover, `video ${video} > cover ${cover}`);
  assert.ok(cover > live, `cover ${cover} > live ${live}`);
});

test('YouTube scoring does not penalise live when the track itself is live', () => {
  const liveTrack = { ...track, title: 'Midnight City (Live)' };
  const c = { title: 'M83 - Midnight City (Live at Coachella)', channel: 'M83', duration: 243 };
  assert.ok(scoreCandidate(c, liveTrack, '') > scoreCandidate(c, track, ''));
});

test('torrent scoring follows the target format', () => {
  const flac = { title: 'M83 - Midnight City [FLAC] [Lossless]', seeders: 10 };
  const mp3 = { title: 'M83 - Midnight City [MP3 320kbps]', seeders: 10 };
  assert.ok(scoreTorrentCandidate(flac, track, 'flac') > scoreTorrentCandidate(mp3, track, 'flac'));
  assert.ok(scoreTorrentCandidate(mp3, track, 'mp3') > scoreTorrentCandidate(flac, track, 'mp3'));
});

test('torrent scoring sinks dead and wrong-artist releases', () => {
  const good = { title: 'M83 - Midnight City [MP3 320kbps]', seeders: 5 };
  const dead = { ...good, seeders: 0 };
  const wrongArtist = { title: 'Some Band - Midnight City [MP3 320kbps]', seeders: 5 };
  assert.ok(scoreTorrentCandidate(good, track, 'mp3') > scoreTorrentCandidate(wrongArtist, track, 'mp3'));
  assert.ok(scoreTorrentCandidate(dead, track, 'mp3') < 20);
});

test('yt-dlp audio quality argument', () => {
  assert.equal(audioQualityArg('320k'), '320K');
  assert.equal(audioQualityArg('128K'), '128K');
  assert.equal(audioQualityArg('best'), '0');
  assert.equal(audioQualityArg(undefined), '0');
});

test('info hash is read from hex magnets only', () => {
  const hash = 'a'.repeat(40);
  assert.equal(infoHashFromMagnet(`magnet:?xt=urn:btih:${hash}&dn=x`), hash);
  assert.equal(infoHashFromMagnet('magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U&dn=x'), '');
  assert.equal(infoHashFromMagnet('http://indexer/download/1.torrent'), '');
});

test('remote path mapping', () => {
  const s = { downloadPathRemote: '/downloads/', downloadPathLocal: '/storage/downloads' };
  assert.equal(mapRemotePath('/downloads/music', s), '/storage/downloads/music');
  assert.equal(mapRemotePath('/downloads', s), '/storage/downloads');
  assert.equal(mapRemotePath('/downloadsextra/x', s), '/downloadsextra/x');
  assert.equal(mapRemotePath('/downloads/music', {}), '/downloads/music');
});

test('seed limits: off at 0, either limit triggers', () => {
  const info = { ratio: 1.5, seedingTime: 3 * 3600 };
  assert.equal(seedLimitReached(info, { seedRatioLimit: 0, seedTimeLimitHours: 0 }), false);
  assert.equal(seedLimitReached(info, { seedRatioLimit: 2 }), false);
  assert.equal(seedLimitReached(info, { seedRatioLimit: 1.5 }), true);
  assert.equal(seedLimitReached(info, { seedTimeLimitHours: 3 }), true);
  assert.equal(seedLimitReached(info, { seedRatioLimit: 5, seedTimeLimitHours: 4 }), false);
  assert.equal(seedLimitReached(info, { seedRatioLimit: '1' }), true, 'string values from the settings form');
});
