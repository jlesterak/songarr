// deemix (github.com/bambanah/deemix) as a download source. Songarr's track
// ids are Deezer ids, so deemix fetches the exact track: no search, no scoring.
// deemix keeps one Deezer login per HTTP session, so we hold its session cookie
// and log in with the ARL on demand (Songarr's own, or the one deemix saved).

import fs from 'fs/promises';
import path from 'path';

const BITRATE = { flac: 9, mp3: 3 }; // deemix codes: 9 FLAC, 3 MP3 320

let session = { url: '', cookie: '' };

export function deemixBitrate(format) {
  return format === 'flac' ? BITRATE.flac : BITRATE.mp3;
}

// deemix names queue items deterministically, so a re-add finds the same item.
export function deemixUuid(trackId, bitrate) {
  return `track_${trackId}_${bitrate}`;
}

function baseUrl(settings) {
  return settings.deemixUrl.replace(/\/+$/, '');
}

async function call(settings, path, { method = 'GET', body } = {}) {
  const url = baseUrl(settings);
  if (session.url !== url) session = { url, cookie: '' };
  const headers = {};
  if (session.cookie) headers.Cookie = session.cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${url}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) session.cookie = setCookie.split(';')[0];
  if (!res.ok) throw new Error(`deemix ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function login(settings) {
  let arl = settings.deemixArl;
  if (!arl) {
    // Single-user deemix hands its saved login to a *new* session only, so drop
    // any cookie from before the login was saved.
    session.cookie = '';
    const info = await call(settings, '/connect');
    arl = info.singleUser?.arl;
  }
  if (!arl) throw new Error('No Deezer ARL: log in to deemix once, or set one in Songarr');
  const r = await call(settings, '/loginArl', { method: 'POST', body: { arl } });
  if (r.status === -1) throw new Error('Deezer is not available from deemix (region?)');
  if (![1, 2, 3].includes(r.status)) throw new Error('Deezer rejected the ARL (expired?)');
  return r.user || {};
}

// Queue a Deezer track in deemix; returns its queue uuid.
export async function addTrack(settings, trackId, bitrate) {
  const body = { url: `https://www.deezer.com/track/${trackId}`, bitrate };
  let r = await call(settings, '/addToQueue', { method: 'POST', body });
  if (!r.result && r.errid === 'NotLoggedIn') {
    await login(settings);
    r = await call(settings, '/addToQueue', { method: 'POST', body });
  }
  if (!r.result) {
    if (r.errid === 'CantStream') throw new Error(`Deezer account can't stream bitrate ${bitrate}`);
    throw new Error(`deemix refused the track (${r.errid || 'unknown error'})`);
  }
  return deemixUuid(trackId, bitrate);
}

// The queue item, or null when deemix no longer has it.
export async function getItem(settings, uuid) {
  const q = await call(settings, '/getQueue');
  return q.queue?.[uuid] || null;
}

export async function removeItem(settings, uuid) {
  await call(settings, `/removeFromQueue?uuid=${encodeURIComponent(uuid)}`, { method: 'POST' });
}

export async function testConnection(settings) {
  const user = await login(settings);
  const name = user.name ? ` as ${user.name}` : '';
  const lossless = user.can_stream_lossless ? 'FLAC available' : 'no FLAC on this account';
  return `Logged in to Deezer${name} (${lossless})`;
}

// deemix leaves a synced-lyrics .lrc and a cover.jpg beside each track. Move
// the .lrc next to the imported file (Navidrome reads it by basename), keep the
// cover only if the album folder has none, then remove deemix's leftovers and
// any album/artist dirs that are now empty (never `root` itself). Best effort.
export async function moveExtras(src, destFile, root) {
  const srcDir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  try {
    const lrc = path.join(srcDir, `${base}.lrc`);
    if (await exists(lrc)) {
      await copyOrMove(lrc, path.join(path.dirname(destFile), `${path.basename(destFile, path.extname(destFile))}.lrc`));
    }
    const cover = path.join(srcDir, 'cover.jpg');
    if (await exists(cover)) {
      const destCover = path.join(path.dirname(destFile), 'cover.jpg');
      if (!(await exists(destCover))) await fs.copyFile(cover, destCover);
      await fs.rm(cover, { force: true });
    }
    let dir = srcDir;
    const stop = root ? path.resolve(root) : null;
    while (stop && path.resolve(dir).startsWith(stop + path.sep)) {
      await fs.rmdir(dir); // throws when not empty, which ends the walk
      dir = path.dirname(dir);
    }
  } catch { /* leftovers are harmless; a non-empty dir ends the walk */ }
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

export async function copyOrMove(src, dest) {
  await fs.rm(dest, { force: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.rm(src, { force: true });
  }
}
