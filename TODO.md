# Songarr TODO

## [IN PROGRESS]
- Torrent path: Prowlarr/Jackett search, qBittorrent/Deluge clients, per-track quality rules, torrent scoring, active-download polling with YouTube fallback. Covered end to end by `npm test` against `server/mocks.js` (all four clients, both indexers); not yet run against real Prowlarr/qBittorrent.

## [PENDING]
- Test the torrent path against the real homelab Prowlarr + download client.
- Containerize and deploy via DockSTARTer, with an upstream-ready ds app template proposal.
- Point the library at the Navidrome music share and confirm M3U sync + auto-scan.

## [COMPLETED]
- Offline `npm test` (node:test, 18 tests): YouTube/torrent scoring, quality rules, DB init + crash recovery, torrent path end to end per client. Live Deezer/Spotify/binary checks moved to `npm run check:live`.
- Fixed bugs the tests exposed: qBittorrent hash was stored as `true` (now resolved by tag or info hash); FLAC/M4A from torrents were renamed to the target extension and had ID3 written into them; album mode recorded a `filePath` that didn't exist; Deluge's `{}` for an unknown hash read as a live torrent; a random fake hash was stored when a client returned none; yt-dlp got `--audio-quality` twice.
- Added remote path mapping (client path -> Songarr path) and `SONGARR_DATA_DIR`/`SONGARR_MUSIC_DIR`/`SONGARR_BIN_DIR`/`SONGARR_TEMP_DIR`.
- `/api/v1/mock` gated behind `SONGARR_MOCKS=1` (off by default; the mock module is only imported when enabled).
- Track-first search (Deezer), YouTube match scoring, yt-dlp/ffmpeg download + ID3 tagging, library layout.
- Navidrome M3U sync and scan webhook; Spotify playlist / plain-text import.
- Rescued from the Gemini antigravity scratch dir to `~/songarr` with an icebox remote (2026-10-04).
