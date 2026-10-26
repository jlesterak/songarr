// ListenBrainz as a linked-playlist source. Source ids:
//   lb:<user>:recommended          the user's unheard collaborative-filtering picks
//   lb:<user>:weekly-exploration   newest playlist of that weekly series
//   lb:<user>:weekly-jams
//   lb:playlist:<mbid>             one fixed playlist
// Every source is a list of recording MBIDs; titles, artists, lengths and ISRCs
// come from one metadata lookup. All public: no token needed.

import fs from 'fs';
import path from 'path';
import { APP_DIR } from './config.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const userAgent = `Songarr/${VERSION} ( https://github.com/jlesterak/songarr )`;
const baseUrl = () => process.env.SONGARR_LISTENBRAINZ_URL || 'https://api.listenbrainz.org';

export const SERIES = { 'weekly-exploration': 'Weekly Exploration', 'weekly-jams': 'Weekly Jams' };
const KINDS = ['recommended', ...Object.keys(SERIES)];
export const RECOMMENDED_COUNT = 50;
const JSPF_PL = 'https://musicbrainz.org/doc/jspf#playlist';
const MBID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Source ids for a ListenBrainz URL or lb: id, or null when it is neither.
// A user ("lb:<user>" or their profile URL) links every kind.
export function listenbrainzIds(input) {
  const s = String(input || '').trim();
  let m = s.match(/listenbrainz\.org\/playlist\/([0-9a-f-]{36})/i) || s.match(/^lb:playlist:([0-9a-f-]{36})$/i);
  if (m) return [`lb:playlist:${m[1].toLowerCase()}`];
  m = s.match(/^lb:([^:\s/]+):([a-z-]+)$/);
  if (m) return KINDS.includes(m[2]) ? [s] : null;
  m = s.match(/^lb:([^:\s/]+)$/) || s.match(/listenbrainz\.org\/user\/([^/?#\s]+)/i);
  return m ? KINDS.map(k => `lb:${decodeURIComponent(m[1])}:${k}`) : null;
}

export const isListenBrainzId = id => String(id || '').startsWith('lb:');

// One retry on 429 (after the wait ListenBrainz asks for) or a dropped
// connection (after 5 s).
async function getJson(urlPath) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(baseUrl() + urlPath, { headers: { 'User-Agent': userAgent } });
    } catch (err) {
      if (attempt > 0) throw new Error(`ListenBrainz ${urlPath.split('?')[0]}: ${err.cause?.code || err.message}`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('X-RateLimit-Reset-In')) || 5, 60);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`ListenBrainz ${urlPath.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }
}

const mbidOf = v => (String([].concat(v)[0] || '').match(MBID) || [])[0]?.toLowerCase() || null;

// Source tracks for recording MBIDs, in order; `fallback` (mbid -> JSPF track)
// fills in when the metadata lookup doesn't know one.
async function describe(mbids, fallback = new Map()) {
  const meta = {};
  for (let i = 0; i < mbids.length; i += 25) {
    Object.assign(meta, await getJson(`/1/metadata/recording/?recording_mbids=${mbids.slice(i, i + 25).join(',')}&inc=artist`));
  }
  const tracks = [];
  for (const mbid of mbids) {
    const m = meta[mbid];
    const jspf = fallback.get(mbid);
    const artists = (m?.artist?.artists || []).map(a => a.name).filter(Boolean);
    const title = m?.recording?.name || jspf?.title;
    const artist = artists[0] || jspf?.creator;
    if (!title || !artist) continue;
    tracks.push({
      title,
      artist,
      artists: artists.length ? artists : [artist],
      album: jspf?.album || '',
      durationMs: m?.recording?.length || jspf?.duration || 0,
      isrcs: m?.recording?.isrcs || [],
      sourceTrackId: `mbid:${mbid}`
    });
  }
  return tracks;
}

async function fromPlaylist(mbid) {
  const p = (await getJson(`/1/playlist/${mbid}`)).playlist;
  const jspf = new Map();
  for (const t of p.track || []) { const id = mbidOf(t.identifier); if (id && !jspf.has(id)) jspf.set(id, t); }
  return { title: p.title, date: p.date, tracks: await describe([...jspf.keys()], jspf) };
}

// { id, name, date, tracks } for a ListenBrainz source id. `date` is when
// ListenBrainz made the playlist (or the recommendations).
export async function fetchListenBrainz(id) {
  const [, who, kind] = String(id).split(':');
  if (who === 'playlist') {
    const p = await fromPlaylist(kind);
    return { id, name: p.title, date: p.date, tracks: p.tracks };
  }
  const user = encodeURIComponent(who);
  if (kind === 'recommended') {
    const payload = (await getJson(`/1/cf/recommendation/user/${user}/recording?count=200`)).payload || {};
    const unheard = (payload.mbids || []).filter(r => !r.latest_listened_at).sort((a, b) => b.score - a.score);
    const mbids = unheard.slice(0, RECOMMENDED_COUNT).map(r => r.recording_mbid);
    const date = payload.last_updated ? new Date(payload.last_updated * 1000).toISOString() : null;
    return { id, name: 'ListenBrainz Recommended', date, tracks: await describe(mbids) };
  }
  if (!SERIES[kind]) throw new Error(`Unknown ListenBrainz source ${id}`);
  const list = ((await getJson(`/1/user/${user}/playlists/createdfor?count=100`)).playlists || []).map(p => p.playlist);
  const newest = list
    .filter(p => p.extension?.[JSPF_PL]?.additional_metadata?.algorithm_metadata?.source_patch === kind)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!newest) throw new Error(`ListenBrainz has no ${SERIES[kind]} playlist for ${who}`);
  const p = await fromPlaylist(mbidOf(newest.identifier));
  return { id, name: SERIES[kind], date: p.date, tracks: p.tracks };
}
