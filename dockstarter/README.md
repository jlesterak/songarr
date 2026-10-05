# DockSTARTer template (proposal)

`.apps/songarr/` follows the DockSTARTer-Templates `.TEMPLATE` starter
(checked against templates commit 93ac6324, 2026-10): same file set minus the
optional `devices.yml`, PUID/PGID/TZ via environment, `/config` from
`DOCKER_VOLUME_CONFIG`, `/music` from `SONGARR__VOLUME_MUSIC` (defaults to
Navidrome's `${DOCKER_VOLUME_STORAGE}/music`). Rendered with no instance suffix
it passes `docker compose config`.

Not installed anywhere. Upstreaming it needs a public image: the x86_64/aarch64
files point at `ghcr.io/jlesterak/songarr`, which does not exist yet. The image
also has to be built for arm64 before the aarch64 file is honest.
