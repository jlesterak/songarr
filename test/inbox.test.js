import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const inbox = await import('../server/inbox.js');
await db.init();

const lib = path.join(env.root, 'music');
const inboxDir = path.join(env.root, 'inbox');
const torrentDir = path.join(env.root, 'torrents');

// Smallest valid-enough FLAC: marker, STREAMINFO and a Vorbis comment block
// (what music-metadata reads); no audio frames needed.
function flac(tags, pad = 0) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  info.writeUIntBE(44100 * 2 ** 12 + (1 << 9) + (15 << 4), 10, 5);
  const enc = s => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
  const vendor = enc('test');
  const cnt = Buffer.alloc(4); cnt.writeUInt32LE(Object.keys(tags).length);
  const body = Buffer.concat([vendor, cnt, ...Object.entries(tags).map(([k, v]) => enc(`${k}=${v}`))]);
  const hdr = (type, last, len) => Buffer.from([(last ? 0x80 : 0) | type, len >> 16, (len >> 8) & 255, len & 255]);
  return Buffer.concat([Buffer.from('fLaC'), hdr(0, false, 34), info, hdr(4, true, body.length), body, Buffer.alloc(pad)]);
}
const put = (rel, buf) => { const p = path.join(inboxDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const settings = () => ({ ...db.getSettings(), libraryPath: lib, inboxPaths: [inboxDir], downloadPathLocal: torrentDir, downloadPathRemote: '' });
// Two scans: the first only records sizes/mtimes
const scan2 = async s => { await inbox.scanInboxes(s, { minAgeMs: 0 }); return inbox.scanInboxes(s, { minAgeMs: 0 }); };

before(() => { fs.mkdirSync(inboxDir, { recursive: true }); inbox.resetInboxState(); });
after(() => env.cleanup());

test('tagged FLAC is moved into the library with its .lrc; inbox left empty', async () => {
  const f = put('Album/x1.flac', flac({ ARTIST: 'The Band', ALBUM: 'Great Record', TITLE: 'Song: One', TRACKNUMBER: '3', DATE: '2001-05-06' }));
  put('Album/x1.lrc', '[00:01.00]hi');
  put('Album/cover.jpg', 'jpg');
  assert.equal(await inbox.scanInboxes(settings(), { minAgeMs: 0 }), 0); // first sight: not stable yet
  assert.ok(fs.existsSync(f));
  assert.equal(await inbox.scanInboxes(settings(), { minAgeMs: 0 }), 1);
  const dest = path.join(lib, 'The Band', 'Great Record (2001)', '03 - Song_ One.flac');
  assert.ok(fs.existsSync(dest));
  assert.ok(fs.existsSync(dest.replace('.flac', '.lrc')));
  assert.ok(fs.existsSync(path.join(lib, 'The Band', 'Great Record (2001)', 'cover.jpg')));
  assert.deepEqual(fs.readdirSync(inboxDir), []);
  const t = db.getTracks().find(x => x.filePath === dest);
  assert.match(t.id, /^inbox:[0-9a-f]{16}$/);
  assert.equal(t.source, 'inbox');
});

test('multi-disc prefixes the disc number', async () => {
  put('d/a.flac', flac({ ARTIST: 'A', ALBUM: 'Two Discs', TITLE: 'T', TRACKNUMBER: '3', DISCNUMBER: '1', DISCTOTAL: '2' }));
  await scan2(settings());
  assert.ok(fs.existsSync(path.join(lib, 'A', 'Two Discs', '1-03 - T.flac')));
});

test('untagged file stays put and is listed', async () => {
  const f = put('u.flac', flac({ ARTIST: 'Nobody' }));
  await scan2(settings());
  assert.ok(fs.existsSync(f));
  const a = inbox.getAttention().find(x => x.path === f);
  assert.deepEqual(a.missing, ['album', 'title']);
  fs.rmSync(f);
});

test('a still-growing file is not moved', async () => {
  const tags = { ARTIST: 'G', ALBUM: 'Growing', TITLE: 'Slow' };
  const f = put('g.flac', flac(tags));
  await inbox.scanInboxes(settings(), { minAgeMs: 0 });
  fs.writeFileSync(f, flac(tags, 100)); // grew
  assert.equal(await inbox.scanInboxes(settings(), { minAgeMs: 0 }), 0);
  assert.ok(fs.existsSync(f));
  assert.equal(await inbox.scanInboxes(settings(), { minAgeMs: 0 }), 1);
});

test('a temp file beside the audio holds the folder back', async () => {
  const f = put('alb/t.flac', flac({ ARTIST: 'H', ALBUM: 'Held', TITLE: 'One' }));
  const tmp = put('alb/two.flac.part', 'partial');
  await scan2(settings());
  assert.ok(fs.existsSync(f));
  fs.rmSync(tmp);
  await inbox.scanInboxes(settings(), { minAgeMs: 0 });
  assert.ok(!fs.existsSync(f));
});

test('duplicate and clashing files are never overwritten', async () => {
  const tags = { ARTIST: 'D', ALBUM: 'Dup', TITLE: 'Same', TRACKNUMBER: '1' };
  const dest = path.join(lib, 'D', 'Dup', '01 - Same.flac');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, flac(tags));
  const f = put('dup.flac', flac(tags));
  await scan2(settings());
  assert.ok(fs.existsSync(f));
  assert.equal(inbox.getAttention().find(x => x.path === f).reason, 'duplicate');
  fs.writeFileSync(f, flac(tags, 50));
  await scan2(settings());
  assert.equal(inbox.getAttention().find(x => x.path === f).reason, 'exists');
  assert.equal(fs.readFileSync(dest).length, flac(tags).length);
});

test('an inbox inside the torrent path is refused', async () => {
  const s = settings();
  assert.match(inbox.inboxProblem(path.join(torrentDir, 'complete'), s), /torrent download path/);
  assert.match(inbox.inboxProblem(env.root, s), /overlaps/); // contains it
  assert.equal(inbox.inboxProblem(inboxDir, s), null);
  const f = path.join(torrentDir, 'x', 'a.flac');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, flac({ ARTIST: 'T', ALBUM: 'T', TITLE: 'T' }));
  await scan2({ ...s, inboxPaths: [path.join(torrentDir, 'x')] });
  assert.ok(fs.existsSync(f));
  assert.equal(inbox.getAttention()[0].reason, 'inbox refused');
});
