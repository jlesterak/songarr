# Songarr TODO

## [IN PROGRESS]

## [PENDING]
- 80 library tracks are MP3 with a FLAC target (imported before the upgrade path, or never re-requested). Re-requesting one upgrades it (checked 2026-10-31); a bulk "upgrade lossy" action would sweep them. The torrent upgrade path (deemix unset) is still proven against mocks only.
- Spotify playlists cap at 100 tracks: the embed page only lists the first 100 (seen 2026-10-12, every big import stopped at exactly 100). Getting past it needs the Spotify Web API, which no longer serves Spotify's own (37i9dQZF…) playlists to client-credentials apps. Decision (owner, 2026-10-18): no Spotify developer app, so the 100-track cap stays; the playlist page now says so when a linked playlist has 100 source tracks.
- SABnzbd still gets the indexer URL (`mode=addurl`); switch to `mode=addfile` if SAB ever runs where it can't reach Prowlarr. SABnzbd/Transmission/Deluge are proven against the mocks only.

## [COMPLETED]
- [COMPLETED] 2026-10-31: confirmed on the live instance: Khruangbin "Time (You and I)" imported from the library (FLAC); an MP3 (Survivor, "Eye of the Tiger") re-requested -> deemix FLAC, MP3 removed after import. The two YouTube 403 tracks resolved (no 403s left; 2,120 of 2,121 imported). The one failure is a MusicBrainz-only track with no YouTube candidates.
- [COMPLETED] 2026-10-31: v0.2.10 released (Jake OK) and live on icebox: the 10-28 "wrong version" review/swap; tests 74/74.
- [COMPLETED] 2026-10-28: "Wrong version" review (🔁 on tracks in the dashboard, queue and playlists). It searches Deezer again, skipping the current and earlier rejected matches and ranking by the playlist source when there is one. "Use this" swaps the track everywhere: linked playlists keep the pick on sync, and the old id isn't offered again. "Same match, different file" deletes the file, blocks its source (that YouTube video, that torrent, or deemix) and re-queues. YouTube imports from before this didn't record their video URL, so they can come back the same. Not released yet; the dialog hasn't been checked in a browser.
- [COMPLETED] 2026-10-26: v0.2.9 (playlist cover mosaics) live on icebox, healthy, cover CSS served. The v0.2.9 publish hung twice in "Build and push" (likely arm64 under QEMU); publish job now times out after 20 min.
- [COMPLETED] 2026-10-25: Navidrome M3U sync confirmed: all 30 Songarr `.m3u8` files show in Navidrome as synced playlists (counts match; log "Finished refreshing playlists" refreshed=31).
- [COMPLETED] 2026-10-25: v0.2.8 deployed on the home server; ListenBrainz user linked, 142/142 matched, the three playlists show in Navidrome and fill as downloads land. ListenBrainz has made no Weekly Exploration/Jams since 2026-09-14 (recommendations are fresh); if they stay stale, set those two to sync off.
- [COMPLETED] 2026-10-25: ListenBrainz playlist sources (recommended, Weekly Exploration, Weekly Jams, single playlists; ISRC-first matching; 142/142 matched live) and bulk playlist edit (API + grid bar). 72 tests.
- [COMPLETED] 2026-10-20: package.json declares `"license": "Unlicense"` to match LICENSE.
- [COMPLETED] 2026-10-19: arm64 build passed on the laptop (`scripts/build-local.sh --all`); `publish.yml` builds linux/amd64 + linux/arm64 (QEMU).
- [COMPLETED] 2026-10-19: README "Known Limitations" covers YouTube's bot check (HTTP 429 on shared IPs). 11 tracks that hit it on 10-12 re-queued; deemix/torrents got them.
(Entries before 2026-10-15 archived 2026-10-24; see git history.)
