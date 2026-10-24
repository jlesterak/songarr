# Songarr TODO

## [IN PROGRESS]

## [PENDING]
- YouTube 403 "unable to download video data" on yt-dlp 2026.08.19 (latest): 2 of ~1,260 tracks (both MusicBrainz matches, so no deemix). Re-requested 2026-10-12. If it keeps happening, look at yt-dlp's PO token / cookies guidance.
- Spotify playlists cap at 100 tracks: the embed page only lists the first 100 (seen 2026-10-12, every big import stopped at exactly 100). Getting past it needs the Spotify Web API, which no longer serves Spotify's own (37i9dQZF…) playlists to client-credentials apps. Leave as a known limit unless a simple route turns up. Decision (owner, 2026-10-18): no Spotify developer app, so the 100-track cap stays; the playlist page now says so when a linked playlist has 100 source tracks.
- Navidrome: scan confirmed working on icebox (2026-10-06); still to confirm M3U sync.
- Confirm live on icebox: re-request Khruangbin "Time (You and I)" is marked imported from the library, and an MP3 in the library upgrades to FLAC via deemix (and via torrent with deemix unset).
- SABnzbd still gets the indexer URL (`mode=addurl`); switch to `mode=addfile` if SAB ever runs where it can't reach Prowlarr. SABnzbd/Transmission/Deluge are proven against the mocks only.
- (Jake) Review `dockstarter/.apps/songarr/` before the upstream PR (needs the public ghcr image first).

## [COMPLETED]
(Entries before 2026-10-15 archived 2026-10-24; see git history.)
- [COMPLETED] 2026-10-20: package.json declares `"license": "Unlicense"` to match LICENSE.
- [COMPLETED] 2026-10-19: arm64 build passed on the laptop (`scripts/build-local.sh --all`: amd64 and arm64 both came up healthy with ffmpeg 8.1.2, ffprobe and yt-dlp 2026.08.19). `publish.yml` now builds linux/amd64 + linux/arm64 (QEMU); the next tag publishes the Pi image.
- [COMPLETED] 2026-10-19: README "Known Limitations" covers YouTube's bot check (HTTP 429 on shared IPs): why it fails, FlareSolverr can't help, retry by re-adding. 11 tracks that hit it on 10-12 re-queued; deemix/torrents got them.
