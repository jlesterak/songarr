# Songarr (track-first music acquisition)

Global rules in `~/.claude/CLAUDE.md` apply. Public GitHub repo (`origin`, push needs Jake's approval) plus a private mirror remote `icebox`.
Keep secrets, private hostnames and home paths out of commits, docs and tests.

- Stack: Vite front end (`src/`), Node server (`server/`), `dist/` is the build, Docker image published to GHCR on a version tag.
- Tests: `npm test` (see `test/`). `scripts/build-local.sh --all` builds amd64 and arm64 locally.
- Deployment: runs on the home server as a DockSTARTER app; the template proposal lives in `dockstarter/.apps/songarr/` and is for upstream, so keep it upstream-ready.
- `TODO.md` is the only todo list; `STATUS.md` is the short summary. Tags and image releases need Jake's approval.
