import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import * as db from './db.js';
import { albumFolder, sanitizeFilename } from './worker.js';
import { copyOrMove } from './deemix.js';

// Drop-folder importer: tagged audio that arrives outside Songarr's own
// requests (e.g. albums downloaded through deemix's web UI) is moved into the
// library under the same layout Songarr's own imports use. Untagged files,
// duplicates and name clashes stay where they are and are listed for the UI.

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus']);
const TEMP_RE = /\.(part|tmp|temp|download|crdownload|partial)(\.|$)|^\./i;

// Last scan's "needs attention" list, and what each file looked like the
// previous cycle (a file is only touched once it is unchanged since then).
let attention = [];
const seen = new Map(); // path -> { size, mtimeMs, at }

export function getAttention() {
  return attention;
}

export function resetInboxState() {
  attention = [];
  seen.clear();
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// Why this folder may not be an inbox, or null. It must never overlap the
// torrent client's download folders (those are removed by the seed limit) or
// the library itself.
export function inboxProblem(dir, settings) {
  if (!dir || !path.isAbsolute(dir)) return 'must be an absolute path';
  const d = path.resolve(dir);
  const guarded = [
    [settings.downloadPathLocal, 'the torrent download path'],
    [settings.downloadPathRemote, 'the torrent download path'],
    [settings.libraryPath, 'the library']
  ];
  for (const [p, name] of guarded) {
    if (!p) continue;
    const g = path.resolve(p);
    if (inside(d, g) || inside(g, d)) return `overlaps ${name} (${g})`;
  }
  return null;
}

async function walk(dir) {
  const out = { files: [], dirs: [] };
  let list;
  try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.dirs.push(p);
    } else if (e.isFile()) {
      out.files.push(p);
    }
  }
  return out;
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

export async function readTags(file) {
  const { parseFile } = await import('music-metadata');
  const { common } = await parseFile(file, { duration: false, skipCovers: true });
  const date = common.date || (common.year ? String(common.year) : '');
  return {
    artist: common.artist || '',
    albumartist: common.albumartist || '',
    album: common.album || '',
    title: common.title || '',
    track: common.track?.no || 0,
    year: /^\d{4}/.test(date) ? date.slice(0, 4) : '',
    date,
    disc: common.disk?.no || 0,
    discs: common.disk?.of || 0
  };
}

export function destinationFor(tags, ext, libraryPath) {
  const artistDir = sanitizeFilename(tags.albumartist || tags.artist);
  const albumDir = albumFolder({ album: tags.album, releaseDate: tags.year });
  let num = tags.track ? String(tags.track).padStart(2, '0') : '';
  if (num && tags.discs > 1 && tags.disc) num = `${tags.disc}-${num}`;
  const title = sanitizeFilename(tags.title);
  const name = num ? `${num} - ${title}` : title;
  return path.join(libraryPath, artistDir, albumDir, `${name}${ext}`);
}

// Directories that hold only what the importer brought along (a cover it
// copied) are tidied; anything else is left alone. Empty dirs go, never `root`.
async function tidy(dir, root, droppedCover) {
  if (droppedCover) {
    const left = (await fs.readdir(dir)).filter(f => f !== 'cover.jpg');
    if (left.length === 0) await fs.rm(path.join(dir, 'cover.jpg'), { force: true });
  }
  let d = dir;
  while (inside(d, root) && d !== root) {
    try { await fs.rmdir(d); } catch { return; } // not empty: stop
    d = path.dirname(d);
  }
}

async function importDir(dir, files, root, settings, report) {
  const result = { imported: 0, remaining: 0 };
  let imported = 0;
  const target = new Set();
  for (const file of files) {
    let tags;
    try {
      tags = await readTags(file);
    } catch (err) {
      attention.push({ path: file, reason: 'unreadable', detail: err.message });
      continue;
    }
    const missing = ['artist', 'album', 'title'].filter(k => !(k === 'artist' ? (tags.artist || tags.albumartist) : tags[k]));
    if (missing.length) {
      attention.push({ path: file, reason: 'missing tags', missing });
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const dest = destinationFor(tags, ext, settings.libraryPath);
    if (await exists(dest)) {
      const [a, b] = await Promise.all([fs.stat(file), fs.stat(dest)]);
      attention.push(a.size === b.size
        ? { path: file, reason: 'duplicate', detail: `already in the library: ${dest}` }
        : { path: file, reason: 'exists', detail: `${dest} exists with a different size` });
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await copyOrMove(file, dest);
    // Lyrics follow under the new basename
    const lrc = path.join(dir, `${path.basename(file, path.extname(file))}.lrc`);
    const destLrc = path.join(path.dirname(dest), `${path.basename(dest, ext)}.lrc`);
    if (await exists(lrc) && !(await exists(destLrc))) await copyOrMove(lrc, destLrc);
    target.add(path.dirname(dest));
    const artist = tags.artist || tags.albumartist;
    const track = {
      id: `inbox:${crypto.createHash('sha1').update(dest).digest('hex').slice(0, 16)}`,
      title: tags.title,
      artists: [artist],
      album: tags.album,
      albumArt: '',
      duration: 0,
      trackNumber: tags.track || undefined,
      releaseDate: tags.date || tags.year || '',
    };
    const existing = db.getTrack(track.id);
    if (!existing) await db.addTrack(track);
    await db.updateTrack(track.id, {
      status: 'imported', source: 'inbox', filePath: dest, format: ext.slice(1),
      bitrate: ext === '.flac' ? 'lossless' : '', error: null
    });
    imported++;
    console.log(`[Inbox] Imported ${file} -> ${dest}`);
  }
  // Cover: copy into each album folder that has none
  let coverCopied = false;
  const cover = path.join(dir, 'cover.jpg');
  if (imported && await exists(cover)) {
    for (const t of target) {
      const dc = path.join(t, 'cover.jpg');
      if (!(await exists(dc))) await fs.copyFile(cover, dc);
    }
    coverCopied = true;
  }
  if (imported) await tidy(dir, root, coverCopied && imported === files.length);
  result.imported = imported;
  return result;
}

// One scan of all inboxes. A directory is only imported when every audio file
// in it is unchanged since the previous scan and no temp file sits beside them,
// so an album that is still downloading is never split. Returns the number of
// tracks imported.
export async function scanInboxes(settings = db.getSettings(), { minAgeMs = 30000, now = Date.now() } = {}) {
  attention = [];
  if (settings.inboxEnabled === false) return 0;
  let total = 0;
  const stillThere = new Set();
  for (const raw of settings.inboxPaths || []) {
    const root = path.resolve(raw);
    const problem = inboxProblem(root, settings);
    if (problem) {
      attention.push({ path: root, reason: 'inbox refused', detail: problem });
      continue;
    }
    if (!(await exists(root))) continue;
    const queue = [root];
    while (queue.length) {
      const dir = queue.shift();
      const { files, dirs } = await walk(dir);
      queue.push(...dirs);
      const names = files.map(f => path.basename(f));
      const audio = files.filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()) && !TEMP_RE.test(path.basename(f)));
      if (audio.length === 0) continue;
      let stable = !names.some(n => TEMP_RE.test(n) && n !== '.DS_Store');
      for (const f of audio) {
        stillThere.add(f);
        const st = await fs.stat(f).catch(() => null);
        if (!st) { stable = false; continue; }
        const prev = seen.get(f);
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
          seen.set(f, { size: st.size, mtimeMs: st.mtimeMs, at: now });
          stable = false;
        } else if (now - prev.at < minAgeMs) {
          stable = false;
        }
      }
      if (!stable) continue;
      try {
        total += (await importDir(dir, audio, root, settings)).imported;
      } catch (err) {
        console.error(`[Inbox] Import from ${dir} failed:`, err.message);
        attention.push({ path: dir, reason: 'import failed', detail: err.message });
      }
    }
  }
  for (const k of seen.keys()) if (!stillThere.has(k)) seen.delete(k);
  return total;
}
