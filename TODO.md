# Songarr TODO

## [IN PROGRESS]
- Torrent path: Prowlarr/Jackett search, qBittorrent/Deluge clients, per-track quality rules, torrent scoring, active-download polling with YouTube fallback. Covered end to end by `npm test` against `server/mocks.js` (all four clients, both indexers); not yet run against real Prowlarr/qBittorrent.

## [PENDING]
- Skip (or mark imported) tracks already in the library: the first real request on icebox (Khruangbin, Time (You and I)) was already at `music/Khruangbin/Time (You and I) (2020)/`.
- SABnzbd still gets the indexer URL (`mode=addurl`); switch to `mode=addfile` if SAB ever runs where it can't reach Prowlarr.
- No auth: `GET /api/v1/settings` returns the indexer API key and client password to anyone on the LAN. Needs at least optional basic auth / masked secrets before a public beta.
- (Jake's OK needed) Real-service test on icebox, where Prowlarr, qbittorrentvpn and Navidrome already run under ds:
  1. Run Songarr on icebox in the ds network (container from this repo, `/config` in appdata, `/music` -> the library's `music/`), or `npm start` on pop-os with SONGARR_DATA_DIR pointed at a scratch dir.
  2. Settings: Download Method `torrent`, Indexer `prowlarr` at `http://prowlarr:9696` + its API key (Prowlarr > Settings > General), client `qbittorrent` at `http://qbittorrentvpn:8080` + WebUI user/pass.
  3. Remote Path Mapping: qbittorrentvpn's save path (e.g. `/downloads`) -> the same folder as Songarr's container sees it (e.g. `/storage/downloads`). Check the qbittorrentvpn compose for the real mount.
  4. Press Test Connections, request one well-seeded track, watch for: hash resolved via the `songarr-<id>` tag, file copied, torrent removed.
  5. Check Cleanuparr's Queue Cleaner leaves `songarr-*` torrents alone (it manages that qBittorrent for Sonarr/Radarr).
  6. Navidrome scan: set its URL (`http://navidrome:4533`), user and Subsonic token; confirm the scan fires and the track shows up.
- SABnzbd/Transmission/Deluge paths work against the mocks only; qBittorrent is the one to prove for real.
- (Jake) Decide where the image lives. Upstream ds needs a public image (`ghcr.io/jlesterak/songarr` in the draft, i.e. GitHub). Private alternative: build on icebox (`docker build -t songarr:local .`) and use a local ds override with that image; ds pulls will warn for it.
- (Jake) Review `dockstarter/.apps/songarr/` before it goes anywhere; then install on icebox or open the upstream PR.
- arm64 build (`docker buildx build --platform linux/arm64`) before claiming aarch64 support in the template.
- Point the library at the Navidrome music share and confirm M3U sync + auto-scan.

## [COMPLETED]
- Dead torrents: no progress for `stallTimeoutMinutes` (default 30) -> removed from the client, remembered in `triedTorrents`, next-best untried release snatched; after `maxTorrentAttempts` (default 3) -> YouTube. Settings UI fields added. Found on icebox: Pharrell "Happy" (Prowlarr said 99 seeders) sat in qBit metaDL with 0 peers while qBit itself was connected (354 DHT nodes). 32 tests.
- Songarr fetches the .torrent itself and uploads it to qBittorrent/Deluge/Transmission (magnet redirects pass through as magnets), like the *arrs. Found on icebox: qbittorrentvpn can't resolve `prowlarr` inside its VPN, so URL adds silently never appeared. Info hash read from the .torrent; qBit's "Fails." now raises. Mocks serve real .torrent files and magnet redirects. YouTube search used `--dump-json` on full results (>1 MB) and overflowed execFile's buffer, so every YouTube search returned nothing; now `--flat-playlist` (~6 KB). 30 tests.
- Album folders are `Album (Year)` (library convention) when Deezer gives a release date; POST /tracks enriches a track that arrives without one. Fixed: a track posted with client-side lifecycle fields (e.g. a raw search result with `status: none`) was stored with that status and never queued; the server now owns status/error/filePath/createdAt/torrentHash, and re-adding a `none` track requeues it. Found in the first real run on icebox. 27 tests.
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
