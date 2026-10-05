# Songarr TODO

## [IN PROGRESS]
- Torrent path: Prowlarr/Jackett search, qBittorrent/Deluge clients, per-track quality rules, torrent scoring, active-download polling with YouTube fallback. Code in place and verified against `server/mocks.js`; not yet run against real Prowlarr/qBittorrent.

## [PENDING]
- Test the torrent path against the real homelab Prowlarr + download client.
- Gate `/api/v1/mock` behind a dev flag (currently mounted unconditionally in `server/index.js`).
- Turn `test-script.js` into a real test suite (`npm test`); it hits live Deezer/Spotify today.
- Containerize and deploy via DockSTARTer, with an upstream-ready ds app template proposal.
- Point the library at the Navidrome music share and confirm M3U sync + auto-scan.

## [COMPLETED]
- Track-first search (Deezer), YouTube match scoring, yt-dlp/ffmpeg download + ID3 tagging, library layout.
- Navidrome M3U sync and scan webhook; Spotify playlist / plain-text import.
- Rescued from the Gemini antigravity scratch dir to `~/songarr` with an icebox remote (2026-10-04).
