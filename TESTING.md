# Testing

One line: how to run each suite, the counts measured at this commit, and what CI runs.

Applies to Aura 1.0.0 · revised 2026-11-11

## Measured at this commit

| Suite | Command | Result |
|---|---|---|
| Python | `python3 -m pytest tests -q -p no:cacheprovider --ignore=tests/e2e --ignore=tests/integration` | **489 passed** |
| Desktop contract | `node --test tests/test_desktop_plugin.mjs` | **132 passed, 0 failed** |
| **Total** | both of the above | **621 passed** |

The README badge counts this total. CI runs the same two commands.

## Python suite

```bash
python3 -m pytest tests -q -p no:cacheprovider --ignore=tests/e2e --ignore=tests/integration
```

Covers capture backends and the idle gate, the FFT and feature extractor, the
HTTP routes and WebSocket framing, single-server election, the player queue and
window control, mood transitions and hooks, configuration coercion, radio
search and stream safety, keyless YouTube search, the three tools, and preset
catalogue logic.

`tests/integration/test_live_server_page.py` starts a live server page and is
excluded from the CI command. `tests/e2e/` drives a real headless Chrome and
measures the canvas; it needs a live audio loopback and a free CPU, so it skips
rather than reporting a false failure on a loaded host. Both are run by hand
when the change touches those paths.

## Desktop contract suite

```bash
node --test tests/test_desktop_plugin.mjs
```

Runs `desktop/plugin.js` against a fake host DOM: the status menu, the docked
pane, transport, per-film resume, mode gating, the settings page, the page
pop-out and playlist management.

Further Node suites exist for the web bridge and catalogue
(`tests/test_web_*.mjs`, `tests/test_presets_catalog.mjs`,
`tests/test_page_gate_and_catalog.mjs`, `tests/test_fresh_install.mjs`,
`tests/test_listen_desktop.mjs`). They are not part of the CI job.

## What CI runs

`.github/workflows/tests.yml`, on every push and pull request:

| Job | Command |
|---|---|
| `python suite` | `python -m pytest tests -q -p no:cacheprovider --ignore=tests/e2e --ignore=tests/integration` (Python 3.12) |
| `desktop contract suite` | `node --test tests/test_desktop_plugin.mjs` (Node 20) |
| `manifest gate` | greps the required `plugin.yaml` fields, prints `manifest ok` |

## Verify it yourself

`VERIFY.md` records the clean-checkout run, the manifest validation and the idle
cost measurements, including what is *not* covered by automated tests (player
seek/resume, drag placement, menu appearance). Test counts there may differ by
one when the optional visualiser skip fires.

Back to [docs/README.md](docs/README.md).
