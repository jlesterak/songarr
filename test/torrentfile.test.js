import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import http from 'http';
import { useTempEnv } from './helpers.js';

const env = useTempEnv();
const { torrentInfoHash, fetchTorrent } = await import('../server/utils.js');
after(() => env.cleanup());

const info = 'd6:lengthi5e4:name3:abc12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae';
const file = Buffer.from(`d8:announce14:http://t/a/b/c7:comment2:hi4:info${info}e`);

test('info hash is the SHA-1 of the raw info dict', () => {
  const expected = crypto.createHash('sha1').update(info).digest('hex');
  assert.equal(torrentInfoHash(file), expected);
});

test('malformed or non-torrent input gives no hash instead of throwing', () => {
  assert.equal(torrentInfoHash(Buffer.from('<html>login</html>')), '');
  assert.equal(torrentInfoHash(Buffer.from('d4:info')), '');
  assert.equal(torrentInfoHash(Buffer.from('d99999:x')), '');
});

test('fetchTorrent: file, magnet redirect, magnet body, and an HTML error page', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/file') return res.end(file);
    if (req.url === '/redirect') { res.writeHead(302, { location: 'magnet:?xt=urn:btih:' + 'A'.repeat(40) }); return res.end(); }
    if (req.url === '/body') return res.end('magnet:?dn=x\n');
    res.end('<html>nope</html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const f = await fetchTorrent(`${base}/file`);
    assert.ok(Buffer.isBuffer(f.torrent));
    assert.equal(f.infoHash, torrentInfoHash(file));
    assert.deepEqual(await fetchTorrent(`${base}/redirect`), { magnet: 'magnet:?xt=urn:btih:' + 'A'.repeat(40), infoHash: 'A'.repeat(40) });
    assert.equal((await fetchTorrent(`${base}/body`)).magnet, 'magnet:?dn=x');
    await assert.rejects(fetchTorrent(`${base}/html`), /not a \.torrent/);
  } finally {
    server.close();
  }
});
