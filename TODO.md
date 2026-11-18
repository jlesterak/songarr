# Songarr TODO

## [IN PROGRESS]

## [PENDING]
- **[PENDING] ~90 Kings of Leon FLACs stuck in the deemix inbox (found 2026-11-18):** 8 albums under the inbox's `Kings Of Leon/` are listed in Inbox attention as "exists with a different size": the library already has a file at the same `Artist/Album (Year)/NN - Title` path. Work out which copy to keep (compare format/bitrate; likely a re-grab of albums already present), then clear the inbox copies. Also decide whether a same-path FLAC with a different size should replace a lossy library file instead of sitting in the inbox.
- Spotify import fails on "Christmas Crackers" (`37i9dQZF1DXaGCh33lYU9t`) with "No tracks found in playlist data structure" (`server/utils.js` `fetchSpotifyPlaylist`), seen twice on 2026-11-18. The embed page is fine: `__NEXT_DATA__` → `props.pageProps.state.data.entity.trackList` holds 80 tracks, so `findTracksRecursively` misses this shape, or the `__NEXT_DATA__` regex (needs exact `type="application/json"`) doesn't match. Repro: `POST /api/v1/tracks/import-playlist` with that URL. Fix: read `entity.trackList` directly before the recursive search, plus a test using a saved copy of the embed page. Once it works, link the playlist add-only like the other 32 Christmas playlists.
- 80 library tracks are MP3 with a FLAC target (imported before the upgrade path, or never re-requested). Re-requesting one upgrades it (checked 2026-10-31); a bulk "upgrade lossy" action would sweep them. The torrent upgrade path (deemix unset) is still proven against mocks only.
- Spotify playlists cap at 100 tracks: the embed page only lists the first 100 (seen 2026-10-12, every big import stopped at exactly 100). Getting past it needs the Spotify Web API, which no longer serves Spotify's own (37i9dQZF…) playlists to client-credentials apps. Decision (owner, 2026-10-18): no Spotify developer app, so the 100-track cap stays; the playlist page now says so when a linked playlist has 100 source tracks.
- SABnzbd still gets the indexer URL (`mode=addurl`); switch to `mode=addfile` if SAB ever runs where it can't reach Prowlarr. SABnzbd/Transmission/Deluge are proven against the mocks only.

## [COMPLETED]
- [COMPLETED] 2026-10-31: confirmed live: library import (FLAC) and deemix MP3-to-FLAC upgrade work; YouTube 403s gone (2,120 of 2,121 imported; the one failure has no YouTube candidates).
- [COMPLETED] 2026-10-31: v0.2.10 released (Jake OK) and live on icebox: the 10-28 "wrong version" review/swap; tests 74/74.
- [COMPLETED] 2026-10-28: "Wrong version" review (search Deezer again and swap everywhere, or delete the file, block its source and re-queue); shipped in v0.2.10.
- [COMPLETED] 2026-10-26: v0.2.9 (playlist cover mosaics) live on icebox; publish job now times out after 20 min (two arm64/QEMU hangs).
- [COMPLETED] 2026-10-25: Navidrome M3U sync confirmed (all 30 `.m3u8` files show as synced playlists).
- [COMPLETED] 2026-10-25: v0.2.8 deployed; ListenBrainz linked, 142/142 matched. Weekly Exploration/Jams were stale since 2026-09-14: if they stay stale, set those two to sync off.
- [COMPLETED] 2026-10-25: ListenBrainz playlist sources (recommended, Weekly Exploration, Weekly Jams, single playlists; ISRC-first matching; 142/142 matched live) and bulk playlist edit (API + grid bar). 72 tests.
- [COMPLETED] 2026-10-20: package.json declares `"license": "Unlicense"` to match LICENSE.
- [COMPLETED] 2026-10-19: arm64 build passed on the laptop (`scripts/build-local.sh --all`); `publish.yml` builds linux/amd64 + linux/arm64 (QEMU).
- [COMPLETED] 2026-10-19: README "Known Limitations" covers YouTube's bot check (HTTP 429 on shared IPs).
(Entries before 2026-10-15 archived 2026-10-24; see git history.)
