# Songarr (track-first music acquisition)

Public GitHub repo (`origin`) plus a private mirror remote `icebox`. Keep private hostnames and home paths out of commits, docs and tests.

- Stack: Vite front end (`src/`), Node server (`server/`), `dist/` is the build, Docker image published to GHCR on a version tag.
- Tests: `npm test` (see `test/`). `scripts/build-local.sh --all` builds amd64 and arm64 locally.
- Deployment: runs on icebox as a DockSTARTer app; `dockstarter/` holds the local override and env example (not submitted upstream: dropped 2026-10-17).
