import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { once } from 'events';
import { useTempEnv, quietConsole } from './helpers.js';

const env = useTempEnv();
quietConsole();
const db = await import('../server/db.js');
const { librarySize, createApp, SECRET_MASK } = await import('../server/app.js');
await db.init();
after(() => env.cleanup());

test('library size is computed in the background and cached, never blocking', async () => {
  const dir = path.join(process.env.SONGARR_MUSIC_DIR, 'A', 'B (2000)');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 - x.flac'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'cover.jpg'), Buffer.alloc(5 * 1024 * 1024));
  assert.equal(librarySize(process.env.SONGARR_MUSIC_DIR), 'Calculating…');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(librarySize(process.env.SONGARR_MUSIC_DIR), '2.0 MB', 'FLAC counted, cover art not');
});

async function serve(env) {
  Object.assign(process.env, env);
  const app = await createApp({ mocks: false });
  for (const k of Object.keys(env)) delete process.env[k];
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('secrets are masked on read; posting the mask back keeps the stored value', async () => {
  const { server, url } = await serve({});
  try {
    await db.updateSettings({ prowlarrApiKey: 'real-key', torrentClientPassword: '' });
    const got = await (await fetch(`${url}/api/v1/settings`)).json();
    assert.equal(got.prowlarrApiKey, SECRET_MASK);
    assert.equal(got.torrentClientPassword, '', 'empty secrets stay empty, not masked');
    const saved = await (await fetch(`${url}/api/v1/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(got)
    })).json();
    assert.equal(saved.prowlarrApiKey, SECRET_MASK);
    assert.equal(db.getSettings().prowlarrApiKey, 'real-key');
    assert.equal((await fetch(`${url}/api/v1/settings`)).headers.get('access-control-allow-origin'), null, 'no CORS');
  } finally {
    server.close();
  }
});

test('basic auth when configured; healthcheck stays open', async () => {
  const { server, url } = await serve({ SONGARR_USERNAME: 'jake', SONGARR_PASSWORD: 'pw' });
  try {
    assert.equal((await fetch(`${url}/api/v1/health`)).status, 200);
    const denied = await fetch(`${url}/api/v1/settings`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /Basic/);
    const wrong = await fetch(`${url}/api/v1/settings`, { headers: { Authorization: 'Basic ' + Buffer.from('jake:nope').toString('base64') } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${url}/api/v1/settings`, { headers: { Authorization: 'Basic ' + Buffer.from('jake:pw').toString('base64') } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
