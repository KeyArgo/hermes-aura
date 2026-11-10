# Changelog

All notable changes to Aura are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-10

First release. The build says which build it is, from the code that is running.

### Added

- **`aura_core/version_stamp.py`**: the version, commit, commit date, build date
  and channel, read from `BUILD_INFO.json` when installed, then live `git` in a
  checkout, then `plugin.yaml`. `VERSION` in the server now comes from this one
  place instead of a constant that had already drifted from `plugin.yaml`.
- **`GET /api/version`**: the same stamp as JSON. Token-gated like every other
  data endpoint; `Cache-Control: no-store` so a restart cannot be answered from
  a stale cache.
- **A version chip** in the visualizer's top bar: `v<version> · <date> ·
  <8-char commit>` (plus `· modified` on a dirty checkout). Clicking it copies
  that exact line, and it only shows the copied state when the clipboard call
  succeeded.

### Changed

- `plugin.yaml` version is now `1.0.0` (was `0.1.1`); the `/healthz` `version`
  field now agrees with it by construction.
- `BUILD_INFO.json` is git-ignored: written per build, never published.
