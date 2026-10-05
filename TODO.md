# Songarr TODO

## [IN PROGRESS]
- Torrent path: Prowlarr/Jackett search, qBittorrent/Deluge clients, per-track quality rules, torrent scoring, active-download polling with YouTube fallback. Covered end to end by `npm test` against `server/mocks.js` (all four clients, both indexers); not yet run against real Prowlarr/qBittorrent.

## [PENDING]
- (Jake's OK needed) Real-service test on icebox, where Prowlarr, qbittorrentvpn and Navidrome already run under ds:
  1. Run Songarr on icebox in the ds network (container from this repo, `/config` in appdata, `/music` -> the library's `music/`), or `npm start` on pop-os with SONGARR_DATA_DIR pointed at a scratch dir.
  2. Settings: Download Method `torrent`, Indexer `prowlarr` at `http://prowlarr:9696` + its API key (Prowlarr > Settings > General), client `qbittorrent` at `http://qbittorrentvpn:8080` + WebUI user/pass.
  3. Remote Path Mapping: qbittorrentvpn's save path (e.g. `/downloads`) -> the same folder as Songarr's container sees it (e.g. `/storage/downloads`). Check the qbittorrentvpn compose for the real mount.
  4. Press Test Connections, request one well-seeded track, watch for: hash resolved via the `songarr-<id>` tag, file copied, torrent removed.
  5. Check Cleanuparr's Queue Cleaner leaves `songarr-*` torrents alone (it manages that qBittorrent for Sonarr/Radarr).
  6. Navidrome scan: set its URL (`http://navidrome:4533`), user and Subsonic token; confirm the scan fires and the track shows up.
- Library layout: Songarr writes `Artist/Album/NN - Title.ext`; the library convention is `music/Artist/Album (Year)/`. Add the year to the album folder.
- SABnzbd/Transmission/Deluge paths work against the mocks only; qBittorrent is the one to prove for real.
- (Jake) Decide where the image lives. Upstream ds needs a public image (`ghcr.io/jlesterak/songarr` in the draft, i.e. GitHub). Private alternative: build on icebox (`docker build -t songarr:local .`) and use a local ds override with that image; ds pulls will warn for it.
- (Jake) Review `dockstarter/.apps/songarr/` before it goes anywhere; then install on icebox or open the upstream PR.
- arm64 build (`docker buildx build --platform linux/arm64`) before claiming aarch64 support in the template.
- Point the library at the Navidrome music share and confirm M3U sync + auto-scan.

## [COMPLETED]
- Seeding is a setting (default on): the torrent stays in the client after import and is removed with its download files at an optional ratio and/or seed-time limit (0 = seed until removed by hand). Library files are hardlinked (no extra space; copy fallback across filesystems, or `importMode: copy`); MP3s are always copied because ID3 tagging edits the file in place and would corrupt the seed. SABnzbd jobs are always removed. 7 new tests (25 total).
- Container: multi-stage `Dockerfile` (vite build, prod deps, node:22-alpine with Alpine ffmpeg and upstream yt-dlp, updated at start unless YTDLP_AUTOUPDATE=false), PUID/PGID/TZ via `docker/entrypoint.sh` (su-exec), `/config` and `/music` volumes, healthcheck. Built and smoke-tested locally (492 MB). yt-dlp now runs with Node as its JS runtime (`--js-runtimes node:...`), which YouTube needs.
- DockSTARTer template proposal in `dockstarter/.apps/songarr/`, following the upstream `.TEMPLATE`; validated with `docker compose config`.
- Offline `npm test` (node:test, 18 tests): YouTube/torrent scoring, quality rules, DB init + crash recovery, torrent path end to end per client. Live Deezer/Spotify/binary checks moved to `npm run check:live`.
- Fixed bugs the tests exposed: qBittorrent hash was stored as `true` (now resolved by tag or info hash); FLAC/M4A from torrents were renamed to the target extension and had ID3 written into them; album mode recorded a `filePath` that didn't exist; Deluge's `{}` for an unknown hash read as a live torrent; a random fake hash was stored when a client returned none; yt-dlp got `--audio-quality` twice.
- Added remote path mapping (client path -> Songarr path) and `SONGARR_DATA_DIR`/`SONGARR_MUSIC_DIR`/`SONGARR_BIN_DIR`/`SONGARR_TEMP_DIR`.
- `/api/v1/mock` gated behind `SONGARR_MOCKS=1` (off by default; the mock module is only imported when enabled).
- Track-first search (Deezer), YouTube match scoring, yt-dlp/ffmpeg download + ID3 tagging, library layout.
- Navidrome M3U sync and scan webhook; Spotify playlist / plain-text import.
- Rescued from the Gemini antigravity scratch dir to `~/songarr` with an icebox remote (2026-10-04).
