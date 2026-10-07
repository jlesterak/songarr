// Playlists linked to a public Spotify playlist: matching each source track to
// the best Deezer result (MusicBrainz when Deezer only has covers/remixes),
// and keeping the Songarr playlist (and its M3U) in step with the source.
// Music files are never deleted: a track dropped from the source only leaves
// the playlist.

import * as db from './db.js';
import * as utils from './utils.js';
import * as worker from './worker.js';
import { withFallback } from './musicbrainz.js';

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Credits and remaster tags describe the original; remix/live/etc. do not.
const baseTitle = t => norm(String(t || '')
  .replace(/[(\[]\s*(feat|ft|with)\b.*?[)\]]/gi, ' ')
  .replace(/[(\[][^)\]]*remaster[^)\]]*[)\]]/gi, ' ')
  .replace(/\s-\s[^-]*remaster.*$/i, ' ')
  .replace(/\s-\s(feat|ft)\b.*$/i, ' '));

export const MATCH_MIN_SCORE = 70;

// Score a Deezer result against a Spotify track (100 = perfect).
export function scoreMatch(cand, src) {
  let score = 100;
  const wantTitle = baseTitle(src.title);
  const gotTitle = baseTitle(cand.title);
  if (gotTitle !== wantTitle) {
    score -= gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle) ? 20 : 60;
  }
  const artists = (src.artists?.length ? src.artists : [src.artist]).map(norm);
  const got = norm(cand.artist);
  if (!artists.some(a => a === got)) score -= artists.some(a => a && (got.includes(a) || a.includes(got))) ? 15 : 50;
  score -= worker.variantPenalty(cand.title, src.title);
  const want = Math.round((src.durationMs || 0) / 1000);
  if (want > 0 && cand.duration > 0) {
    const diff = Math.abs(want - cand.duration);
    if (diff > 5) score -= Math.min(30, diff - 5);
  }
  return score;
}

export function pickMatch(results, src) {
  let best = null;
  let bestScore = -Infinity;
  for (const r of results) {
    const s = scoreMatch(r, src);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return bestScore >= MATCH_MIN_SCORE ? best : null;
}

// Deezer track (or MusicBrainz original) for a Spotify track, or null. The
// Spotify embed doesn't expose ISRCs, so matching is by title/artist/duration.
export async function matchTrack(src) {
  const results = await utils.searchDeezer(`${src.artist} - ${src.title}`);
  let match = pickMatch(results, src);
  if (!match) {
    const withMb = await withFallback(`${src.artist} ${src.title}`, results);
    if (String(withMb[0]?.id).startsWith('mb:') && scoreMatch(withMb[0], src) >= MATCH_MIN_SCORE) match = withMb[0];
  }
  if (!match) return null;
  if (String(match.id).startsWith('mb:')) return match;
  return (await utils.getDeezerTrackDetails(match.id)) || match;
}

const sourceKey = s => s.spotifyId || `${norm(s.artist)}|${norm(s.title)}`;

// Creates the linked playlist for a Spotify URL, or finds the one already
// linked to that playlist id. Returns { playlist, source }.
export async function linkPlaylist(url) {
  const id = utils.spotifyPlaylistId(url);
  if (!id) throw new Error('Invalid Spotify playlist URL format');
  const source = await utils.fetchSpotifyPlaylist(id);
  let playlist = db.findPlaylistBySource(id);
  if (!playlist) {
    playlist = await db.createPlaylist(source.name || `Spotify ${id}`, '', {
      sourceId: id,
      sourceUrl: `https://open.spotify.com/playlist/${id}`,
      sourceName: source.name || '',
      lastSyncedAt: null,
      sourceTracks: [],
      unmatched: []
    });
  }
  return { playlist, source };
}

const running = new Set();

// Re-reads the source and brings the playlist in line. A failed or empty fetch
// changes nothing.
export async function syncPlaylist(id, prefetched = null) {
  const pl = db.getPlaylists().find(p => p.id === id);
  if (!pl || !pl.sourceId || running.has(id)) return null;
  running.add(id);
  try {
    let source;
    try {
      source = prefetched || await utils.fetchSpotifyPlaylist(pl.sourceId);
      if (!source.tracks.length) throw new Error('Source playlist has no tracks');
    } catch (err) {
      await db.updatePlaylist(id, { lastSyncAttemptAt: new Date().toISOString(), lastSyncError: err.message });
      return null;
    }

    const known = new Map((pl.sourceTracks || []).map(s => [s.key, s]));
    const sourceTracks = [];
    const unmatched = [];
    for (const src of source.tracks) {
      const key = sourceKey(src);
      let trackId = known.get(key)?.trackId || null;
      if (!trackId) {
        try {
          const match = await matchTrack(src);
          if (match) trackId = (await db.addTrack(match)).id;
        } catch (err) {
          console.error(`[Sync] Matching ${src.artist} - ${src.title} failed: ${err.message}`);
        }
      }
      if (!trackId) unmatched.push(`${src.artist} - ${src.title}`);
      sourceTracks.push({ key, title: src.title, artist: src.artist, durationMs: src.durationMs || 0, trackId });
    }

    // Source order, then anything the user added by hand.
    const oldSourceIds = new Set((pl.sourceTracks || []).map(s => s.trackId).filter(Boolean));
    const fromSource = [...new Set(sourceTracks.map(s => s.trackId).filter(Boolean))];
    const manual = pl.trackIds.filter(t => !oldSourceIds.has(t) && !fromSource.includes(t));
    const now = new Date().toISOString();
    const { playlist } = await db.updatePlaylist(id, {
      trackIds: [...fromSource, ...manual],
      sourceTracks,
      unmatched,
      sourceName: source.name || pl.sourceName,
      lastSyncedAt: now,
      lastSyncAttemptAt: now,
      lastSyncError: null
    });
    await worker.regenerateM3UPlaylist(db.getPlaylists().find(p => p.id === id));
    worker.processQueue().catch(err => console.error('[Sync] queue start failed:', err.message));
    console.log(`[Sync] ${playlist.name}: ${fromSource.length} tracks, ${unmatched.length} unmatched.`);
    return playlist;
  } finally {
    running.delete(id);
  }
}

// Syncs every linked playlist that is due (setting playlistSyncHours; 0 = off).
export async function syncDue(now = Date.now()) {
  const hours = Number(db.getSettings().playlistSyncHours) || 0;
  if (hours <= 0) return;
  for (const pl of db.getPlaylists()) {
    if (!pl.sourceId) continue;
    const last = Date.parse(pl.lastSyncAttemptAt || pl.lastSyncedAt || 0) || 0;
    if (now - last >= hours * 3600e3) await syncPlaylist(pl.id).catch(err => console.error('[Sync]', err.message));
  }
}

let timer = null;
export function startSyncLoop() {
  if (timer) return;
  timer = setInterval(() => syncDue().catch(() => {}), 15 * 60 * 1000);
  timer.unref();
  setTimeout(() => syncDue().catch(() => {}), 60 * 1000).unref();
}
