import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { once } from 'events';
import { useTempEnv, quietConsole } from './helpers.js';

// deemix path against a fake deemix web API: login with the ARL deemix saved,
// queue the exact Deezer id, poll the queue, move the file into the library.

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const worker = await import('../server/worker.js');

const dlDir = path.join(env.root, 'deemix-downloads');
fs.mkdirSync(dlDir);

// Fake deemix: one session cookie, saved ARL "abc123", items finish on the
// second getQueue. failIds end with no file, like a track Deezer won't serve.
const fake = { loggedIn: false, queue: {}, polls: {}, removed: [], failIds: new Set() };
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  const url = new URL(req.url, 'http://x');
  const send = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  res.setHeader('Set-Cookie', 'connect.sid=s1; Path=/; HttpOnly');
  switch (url.pathname) {
    case '/api/connect':
      return send({ autologin: !fake.loggedIn, singleUser: { arl: 'abc123' } });
    case '/api/loginArl':
      fake.loggedIn = json.arl === 'abc123' && req.headers.cookie === 'connect.sid=s1';
      return send({ status: fake.loggedIn ? 1 : 0, user: { name: 'jake', can_stream_lossless: true } });
    case '/api/addToQueue': {
      if (!fake.loggedIn) return send({ result: false, errid: 'NotLoggedIn' });
      const id = json.url.split('/').pop();
      const uuid = `track_${id}_${json.bitrate}`;
      if (fake.queue[uuid]) return send({ result: true }); // real deemix keeps the old item
      fake.queue[uuid] = { uuid, status: 'inQueue', id, ext: json.bitrate === 9 ? 'flac' : 'mp3' };
      return send({ result: true });
    }
    case '/api/getQueue': {
      for (const item of Object.values(fake.queue)) {
        fake.polls[item.uuid] = (fake.polls[item.uuid] || 0) + 1;
        if (fake.polls[item.uuid] === 1) item.status = 'downloading';
        else if (item.status === 'downloading') {
          if (fake.failIds.has(item.id)) {
            Object.assign(item, { status: 'failed', files: [], errors: [{ message: 'Track not available' }] });
          } else {
            const file = path.join(dlDir, `${item.id}.${item.ext}`);
            fs.writeFileSync(file, 'audio');
            Object.assign(item, { status: 'completed', files: [{ path: file }] });
          }
        }
      }
      return send({ queue: fake.queue, queueOrder: [] });
    }
    case '/api/removeFromQueue':
      fake.removed.push(url.searchParams.get('uuid'));
      delete fake.queue[url.searchParams.get('uuid')];
      delete fake.polls[url.searchParams.get('uuid')];
      return send({ result: true });
  }
  res.statusCode = 404;
  res.end();
});

before(async () => {
  await db.init();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await db.updateSettings({
    autoDownload: false,
    downloadMethod: 'direct',
    audioFormat: 'flac',
    qualityRules: [],
    deemixUrl: `http://127.0.0.1:${server.address().port}`,
    deemixArl: ''
  });
});

after(() => {
  server.close();
  env.cleanup();
});

async function runUntilSettled(id, maxCycles = 5) {
  for (let i = 0; i < maxCycles; i++) {
    await worker.processQueue();
    const t = db.getTrack(id);
    if (['imported', 'failed'].includes(t.status)) return t;
  }
  return db.getTrack(id);
}

test('deemix grabs the exact Deezer track as FLAC and moves it into the library', async () => {
  await db.addTrack({ id: '3135556', title: 'Harder, Better, Faster, Stronger', artists: ['Daft Punk'], album: 'Discovery', releaseDate: '2001-03-07', trackNumber: 4, duration: 224 });
  const t = await runUntilSettled('3135556');
  assert.equal(t.status, 'imported');
  assert.equal(t.source, 'deemix');
  assert.equal(t.format, 'flac');
  const expected = path.join(db.getSettings().libraryPath, 'Daft Punk', 'Discovery (2001)', '04 - Harder, Better, Faster, Stronger.flac');
  assert.equal(t.filePath, expected);
  assert.ok(fs.existsSync(expected));
  assert.ok(!fs.existsSync(path.join(dlDir, '3135556.flac')), 'download copy is moved, not left behind');
  assert.deepEqual(fake.removed, ['track_3135556_9']);
});

test('a track deemix cannot deliver falls back to the configured mode', async () => {
  fake.failIds.add('999');
  await db.addTrack({ id: '999', title: 'Nope', artists: ['Nobody'], album: 'X', duration: 100 });
  const t = await runUntilSettled('999');
  // The test env's yt-dlp always fails, so the YouTube fallback ends in failed;
  // what matters is that deemix was given up on and YouTube was tried.
  assert.equal(t.status, 'failed');
  assert.equal(t.deemixTried, true);
  assert.equal(t.deemixUuid, null);
  assert.doesNotMatch(t.error, /^deemix:/);
  // Re-requesting a failed track gives deemix another go.
  const again = await db.addTrack({ id: '999' });
  assert.equal(again.deemixTried, false);
});

test('moveExtras moves the .lrc, keeps an existing cover, and removes empty deemix dirs', async () => {
  const deemix = await import('../server/deemix.js');
  const root = path.join(env.root, 'dl2');
  const album = path.join(root, 'Queen', 'Jazz (1978)');
  fs.mkdirSync(album, { recursive: true });
  const src = path.join(album, "12 - Don't Stop.flac");
  fs.writeFileSync(src, 'a');
  fs.writeFileSync(path.join(album, "12 - Don't Stop.lrc"), 'lyrics');
  fs.writeFileSync(path.join(album, 'cover.jpg'), 'deemix cover');
  const lib = path.join(env.root, 'lib2');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'cover.jpg'), 'mine');
  const dest = path.join(lib, '12 - Dont Stop.flac');
  fs.renameSync(src, dest);
  await deemix.moveExtras(src, dest, root);
  assert.equal(fs.readFileSync(path.join(lib, '12 - Dont Stop.lrc'), 'utf8'), 'lyrics');
  assert.equal(fs.readFileSync(path.join(lib, 'cover.jpg'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(root), 'the downloads root itself stays');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a stale failed deemix item is removed and re-added on re-request', async () => {
  fake.removed.length = 0;
  fake.queue['track_777_9'] = { uuid: 'track_777_9', id: '777', status: 'failed', files: [], errors: [{ message: 'old' }] };
  fake.polls['track_777_9'] = 5;
  await db.addTrack({ id: '777', title: 'Again', artists: ['Someone'], album: 'Y', duration: 100 });
  const t = await runUntilSettled('777');
  assert.equal(t.status, 'imported');
  assert.equal(t.source, 'deemix');
  assert.ok(fake.removed.includes('track_777_9'));
});

test('MusicBrainz fallback: original offered with an mb: id, deemix never called for it', async () => {
  const mbCalls = [];
  const mb = http.createServer((req, res) => {
    mbCalls.push({ url: req.url, ua: req.headers['user-agent'] });
    res.setHeader('Content-Type', 'application/json');
    const cr = name => [{ name }];
    res.end(JSON.stringify({ recordings: [
      { id: 'cover-1', title: 'Somebody That I Used to Know', 'artist-credit': cr('Gotye'), length: 200000, releases: [{ id: 'r0', title: 'Tiny' }] },
      { id: 'orig-1', title: 'Somebody That I Used to Know', 'artist-credit': cr('Gotye'), length: 244973, 'first-release-date': '2011-07-05',
        releases: [{ id: 'r1', title: 'Bravo Hits 76', date: '2011', 'release-group': { 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
                   { id: 'r2', title: 'Making Mirrors', date: '2011-07-05', 'release-group': { 'primary-type': 'Album', 'secondary-types': [] } }] }
    ] }));
  });
  mb.listen(0, '127.0.0.1');
  await once(mb, 'listening');
  process.env.SONGARR_MUSICBRAINZ_URL = `http://127.0.0.1:${mb.address().port}`;
  const { withFallback } = await import('../server/musicbrainz.js');
  const remix = { id: '1', artist: 'Gotye', title: 'Somebody That I Used To Know (Dumme Jungs Remix)' };
  const cover = { id: '2', artist: 'Walk Off The Earth', title: 'Somebody That I Used to Know' };
  const out = await withFallback('Gotye Somebody That I Used To Know', [remix, cover]);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'mb:orig-1');
  assert.equal(out[0].album, 'Making Mirrors');
  assert.equal(out[0].duration, 245);
  assert.match(mbCalls[0].ua, /^Songarr\/\d+\.\d+\.\d+ \( https:\/\/github.com\/jlesterak\/songarr \)$/);
  // a plausible original, or a title-only query, makes no MusicBrainz call
  const n = mbCalls.length;
  const real = { id: '3', artist: 'Gotye', title: 'Somebody That I Used To Know (feat. Kimbra)' };
  assert.equal((await withFallback('Gotye Somebody That I Used To Know', [real, remix])).length, 2);
  assert.equal((await withFallback('Somebody That I Used To Know', [remix, cover])).length, 2);
  assert.equal(mbCalls.length, n);
  mb.close();
  delete process.env.SONGARR_MUSICBRAINZ_URL;

  // deemix is skipped for the mb: id
  const calls = fake.removed.length + Object.keys(fake.queue).length;
  await db.addTrack({ ...out[0] });
  await worker.processQueue();
  assert.equal(fake.removed.length + Object.keys(fake.queue).length, calls);
  assert.ok(!fake.queue['track_mb:orig-1_9']);
  assert.equal(db.getTrack('mb:orig-1').deemixTried ?? false, false);
});
