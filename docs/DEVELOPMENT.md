# Development

One line: repo layout, local setup, the test commands and how CI is wired.

Applies to Aura 1.0.0 · revised 2026-11-11

## Layout

| Path | What lives there |
|---|---|
| `plugin.yaml` | Manifest: version, Hermes floor, tools, hooks, dashboard. |
| `__init__.py` | Plugin entry point: tools, hooks, server boot. |
| `aura_core/` | Capture backends, analysis, config, server, moods, sessions, radio, search, pop-out window. |
| `dashboard/` | `plugin_api.py`, the FastAPI router the desktop half calls. |
| `desktop/plugin.js` | Hermes Desktop half. |
| `web/` | Visualiser (`aura.js`), audio channel (`audio.js`), film stage (`player.html`), presets and vendored Butterchurn. |
| `tests/` | Python suite, Node contract suites, `tests/e2e`, `tests/integration`. |
| `tools/` | Development probes and servers; not shipped behaviour. |
| `assets/` | Hero SVG, diagrams, README renders, catalogue banner. |
| `docs/` | The documentation in [docs/README.md](README.md). |

## Setup

Requirements: Python 3.11 or newer, Node 18 or newer for the desktop suite, and
a Linux desktop with PipeWire or PulseAudio for real capture.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install pytest
node --version
```

Aura's runtime is pure Python stdlib. The only declared dependencies are the
Windows-only capture packages in `plugin.yaml` (`soundcard`, `numpy`).

## Run the suites

```bash
# Python: capture, analysis, server, catalog, hooks, radio, tools
python3 -m pytest tests -q --ignore=tests/e2e --ignore=tests/integration

# Desktop contract suite: menu, pane, transport, resume, mode gating
node --test tests/test_desktop_plugin.mjs
```

The end-to-end visualiser tests need Chrome and a live audio loopback; they live
in `tests/e2e/` and are excluded above. `tests/integration/` starts a live
server page and is also excluded from the CI command. Current counts and what CI
runs: [TESTING.md](../TESTING.md).

## How CI works

`.github/workflows/tests.yml` has three jobs on every push and pull request:

| Job | What it runs |
|---|---|
| `python suite` | Python 3.12, `pip install pytest`, `python -m pytest tests -q -p no:cacheprovider --ignore=tests/e2e --ignore=tests/integration`. |
| `desktop contract suite` | Node 20, `node --test tests/test_desktop_plugin.mjs`. |
| `manifest gate` | Greps `plugin.yaml` for the fields the catalog reads. |

The manifest check is intentionally dependency-free; it fails if `name`,
`version`, `author`, `label`, `description`, `requires_hermes` or `license`
disappears.

## Conventions

- Runtime code is stdlib only; new Python dependencies need an upper bound
  (`>=X,<Y`).
- Plugins extend Hermes only through public hooks, `ctx.register_*` APIs and the
  Desktop SDK.
- Every hook swallows its own exceptions and returns `None`; a hook must never
  break an agent turn.
- A tool must always answer JSON, including on failure.
- Tests run against a temporary `HERMES_HOME` (`tests/conftest.py`) and set
  `AURA_CAPTURE=none` where real audio would make results nondeterministic.
- Commit style follows the history: `docs: …`, `ci: …`, `chore: …`, `readme: …`.

## Development tools

| Script | Use |
|---|---|
| `tools/serve_live.py` | Start the real server and capture loop; prints a URL. |
| `tools/kick_server.py` | Serve the real page with a synthetic 120 BPM kick stream; no audio device. |
| `tools/repro_local.py` | Drive Chrome over CDP and sample the visual. |
| `tools/kick_probe.py` | Dense in-page probe of the beat response. |
| `tools/record_demo.py` | Record a visual demo. |
| `tools/probe_all_presets.py`, `tools/score_presets.mjs` | Preset catalogue probes. |
| `tools/build_presets_catalog.mjs` | Rebuild `web/presets.json`. |
| `tools/stamp_build.py` | Write `BUILD_INFO.json` (gitignored) for the version stamp. |

Some tools need `websocket-client` and Pillow in the system Python; the plugin
itself does not.

## Version stamp

`aura_core/version_stamp.py` reports version, commit, commit date and dirty
state. Precedence: `BUILD_INFO.json`, then live git, then `plugin.yaml`. The
desktop header and `GET /api/plugins/aura/version` read the same module.

Back to [docs/README.md](README.md).
