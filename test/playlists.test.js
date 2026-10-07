import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const sync = await import('../server/sync.js');
await db.init();
await db.updateSettings({ deemixUrl: '', autoDownload: false });
after(() => env.cleanup());

// Spotify and Deezer at the fetch boundary.
let spotifyTracks = [];
const deezer = {
  'Artist - Song': [
    { id: 1, title: 'Song (Extended Remix)', artist: { name: 'Artist' }, album: { title: 'Remixes' }, duration: 400 },
    { id: 2, title: 'Song', artist: { name: 'Artist' }, album: { title: 'Album' }, duration: 200 }
  ],
  'Artist - Other': [{ id: 3, title: 'Other', artist: { name: 'Artist' }, album: { title: 'Album' }, duration: 180 }]
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes('open.spotify.com/embed')) {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { state: { data: { entity: { name: 'My Mix', trackList: spotifyTracks.map(t => ({ title: t[1], subtitle: t[0], duration: t[2] * 1000, uri: `spotify:track:${t[1]}` })) } } } } }
    })}</script>`;
    return new Response(html);
  }
  const search = url.match(/api\.deezer\.com\/search\?q=(.*)$/);
  if (search) return Response.json({ data: deezer[decodeURIComponent(search[1])] || [] });
  const det = url.match(/api\.deezer\.com\/track\/(\d+)/);
  if (det) {
    const t = Object.values(deezer).flat().find(x => String(x.id) === det[1]);
    return Response.json({ ...t, isrc: '', release_date: '2020-01-01', track_position: 1 });
  }
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

const URL1 = 'https://open.spotify.com/playlist/AbC123xyz0';

test('matching rejects a remix when the original exists', async () => {
  const m = await sync.matchTrack({ title: 'Song', artist: 'Artist', durationMs: 200000 });
  assert.equal(m.id, '2');
});

test('re-importing the same URL (any spelling) reuses one playlist', async () => {
  spotifyTracks = [['Artist', 'Song', 200]];
  const a = await sync.linkPlaylist(URL1);
  const b = await sync.linkPlaylist(URL1 + '?si=abcdef&utm=x');
  assert.equal(a.playlist.id, b.playlist.id);
  assert.equal(db.getPlaylists().length, 1);
  assert.equal(b.playlist.sourceName, 'My Mix');
});

test('sync adds a new track, drops a removed one but keeps its file', async () => {
  const pl = db.getPlaylists()[0];
  await sync.syncPlaylist(pl.id);
  assert.deepEqual(db.getPlaylists()[0].trackIds, ['2']);

  // The track is downloaded; then the source swaps it for another.
  const file = path.join(process.env.SONGARR_MUSIC_DIR, 'Artist', 'Album (2020)', '01 - Song.mp3');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'audio');
  await db.updateTrack('2', { status: 'imported', filePath: file });
  spotifyTracks = [['Artist', 'Other', 180], ['Nobody', 'Ghost', 100]];
  await sync.syncPlaylist(pl.id);

  const after = db.getPlaylists()[0];
  assert.deepEqual(after.trackIds, ['3']);
  assert.deepEqual(after.unmatched, ['Nobody - Ghost']);
  assert.ok(fs.existsSync(file), 'music file stays');
  assert.ok(db.getTrack('2'), 'track record stays');
});

test('duplicate playlist names get a unique name, and so a unique M3U', async () => {
  const worker = await import('../server/worker.js');
  const a = await db.createPlaylist('Road Trip');
  const b = await db.createPlaylist('road trip');
  assert.equal(b.name, 'road trip (2)');
  await worker.regenerateM3UPlaylist({ ...a, tracks: [] });
  await worker.regenerateM3UPlaylist({ ...b, tracks: [] });
  const dir = path.join(process.env.SONGARR_MUSIC_DIR, 'Playlists');
  assert.ok(fs.existsSync(path.join(dir, 'Road Trip.m3u')) && fs.existsSync(path.join(dir, 'road trip (2).m3u')));
});
