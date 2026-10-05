# Songarr

[![GitHub Stars](https://img.shields.io/github/stars/jlesterak/songarr?style=flat-square&color=607D8B&label=github%20stars&logo=github)](https://github.com/jlesterak/songarr)
[![Compose Templates](https://img.shields.io/static/v1?style=flat-square&color=607D8B&label=compose&message=templates)](https://github.com/GhostWriters/DockSTARTer-Templates/tree/main/.apps/songarr)

## Description

[Songarr](https://github.com/jlesterak/songarr) is a track-first music request
app: search for a single song, and it is downloaded, tagged and filed into your
music library, filling the gap Lidarr leaves by working only in whole albums.

## Install/Setup

The library is mounted at `/music`, from `SONGARR__VOLUME_MUSIC`, which defaults
to the same `${DOCKER_VOLUME_STORAGE}/music` folder Navidrome uses. In Songarr's
settings, leave the Library Path as `/music`.

To download through a torrent client instead of YouTube, point Songarr at
Prowlarr (or Jackett) and the client in its settings. If the client reports
save paths Songarr can't see (for example `/downloads` inside the client's
container), set the Remote Path Mapping so the same folder resolves under one
of Songarr's `/storage` mounts.
