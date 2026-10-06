// MusicBrainz fallback for searches where Deezer only has covers/remixes of a
// major-label original (Gotye "Somebody That I Used To Know"). Only used when
// the query names an artist (found among Deezer's own results) and none of the
// results is that artist's track with that exact title. Such tracks get an
// `mb:<recording-mbid>` id, never a Deezer id, so deemix is never asked for them.

import fs from 'fs';
import path from 'path';
import { APP_DIR } from './config.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const userAgent = `Songarr/${VERSION} ( https://github.com/jlesterak/songarr )`;
const baseUrl = () => process.env.SONGARR_MUSICBRAINZ_URL || 'https://musicbrainz.org';

export const isDeezerId = id => /^\d+$/.test(String(id));

const norm = s => ` ${String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
// Only credits are dropped: "(feat. X)" is still the original, "(... Remix)" is not.
const stripParens = s => s.replace(/[(\[]\s*(feat|ft|with)\b.*?[)\]]/gi, ' ');

// MusicBrainz allows 1 request/second: serialise and space the calls.
let chain = Promise.resolve();
let lastCall = 0;
function rateLimited(fn) {
  const run = chain.then(async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

const cache = new Map();

async function lookup(artist, title) {
  const key = `${norm(artist)}|${norm(title)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.value;
  const q = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}" AND status:official`;
  const data = await rateLimited(async () => {
    const res = await fetch(`${baseUrl()}/ws/2/recording?${new URLSearchParams({ query: q, fmt: 'json', limit: '25' })}`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return res.json();
  });
  const value = pickOriginal(data.recordings || [], artist, title);
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Exact title by that artist, and of those the recording on the most releases
// (the original is on hundreds of releases; remixes and live takes on a few).
export function pickOriginal(recordings, artist, title) {
  const wantArtist = norm(artist);
  const wantTitle = norm(title);
  const best = recordings
    .filter(r => norm(r.title) === wantTitle && norm(r['artist-credit']?.[0]?.name || '') === wantArtist)
    .sort((a, b) => (b.releases?.length || 0) - (a.releases?.length || 0))[0];
  if (!best) return null;
  const releases = best.releases || [];
  const plain = releases
    .filter(r => r['release-group']?.['primary-type'] === 'Album' && !(r['release-group']['secondary-types'] || []).length)
    .sort((a, b) => (a.date || '9').localeCompare(b.date || '9'))[0];
  const rel = plain || releases[0];
  return {
    id: `mb:${best.id}`,
    title: best.title,
    artist: best['artist-credit'][0].name,
    artists: [best['artist-credit'][0].name],
    album: rel?.title || best.title,
    albumArt: rel ? `https://coverartarchive.org/release/${rel.id}/front-500` : '',
    duration: best.length ? Math.round(best.length / 1000) : 0,
    releaseDate: best['first-release-date'] || '',
    trackNumber: 1,
    isrc: '',
    link: `https://musicbrainz.org/recording/${best.id}`,
    metadataSource: 'musicbrainz'
  };
}

// Deezer results, with the canonical MusicBrainz track in front when Deezer
// has no plausible original for an "artist title" query. Never throws.
export async function withFallback(query, deezerResults) {
  try {
    const q = norm(query);
    const artists = [...new Set(deezerResults.map(r => r.artist))]
      .filter(a => q.includes(norm(a)))
      .sort((a, b) => b.length - a.length);
    const artist = artists[0];
    if (!artist) return deezerResults;
    const title = q.replace(norm(artist), ' ').trim();
    if (!title) return deezerResults;
    const plausible = deezerResults.some(r => norm(r.artist) === norm(artist) && norm(stripParens(r.title)) === norm(title));
    if (plausible) return deezerResults;
    const mb = await lookup(artist, title);
    return mb ? [mb, ...deezerResults] : deezerResults;
  } catch (err) {
    console.warn(`[MusicBrainz] fallback skipped: ${err.message}`);
    return deezerResults;
  }
}
