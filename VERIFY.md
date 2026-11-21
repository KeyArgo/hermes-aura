# Verify Aura yourself

Everything below was run on a clean checkout of this repository, on Linux (X11/Wayland host),
Python 3.14, Node 22. Numbers are from those runs, not estimates.

## Test suite

```bash
# Python half — capture, analysis, server, catalog, hooks, web bridge
env -u PYTHONPATH TMPDIR=/tmp python3 -m pytest tests -q -o addopts="" --ignore=tests/e2e
#   → 489 passed, 1 skipped in 34.5s

# Desktop half — menu, pane, transport, resume, mode gating (contract tests)
node --test tests/test_desktop_plugin.mjs
#   → 132 passed, 0 failed
```

The one skip is the visualiser end-to-end test: it needs a free CPU and a live PulseAudio
monitor, and it skips rather than reporting a false pass when the host is loaded.

## Manifest gate

```bash
hermes plugins validate .
#   → exit 0 · "ok": true · 0 errors · 1 warning
```

The validation output above is historical. Aura no longer imports the private
active-session registry or reads its file.

## Idle cost

Aura stops listening when nothing is open. With no Aura surface attached:

| Thread | CPU, idle |
|---|---|
| `aura-capture` (analysis) | 3.40 % of one core — before the idle fix; `"capture": "none"` after it |
| `aura-capture-pulse` (feeder) | 0.33 % |
| `parec` (recorder) | 0.25 % |

After `IDLE_STOP_S` (30 s) with no connected page the capture loop swaps to silence; the first
page back reopens the backend. Two tests drive that loop directly
(`tests/test_capture_gate.py`): idle → silence → a page returns → reopen, and `listen_background`
keeping it alive with nobody watching. `listen_background` in the config keeps the old always-on
behaviour. Measure it yourself:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.hermes/aura/token)" \
  "http://127.0.0.1:$(jq -r .port ~/.hermes/aura/lease.json)/healthz"
# "capture" reads "none" once idle
```

Behind chat is the one surface that is not Aura's own, and it lives in the desktop's backdrop layer
(`BACKDROP_AREA`): `tests/test_behind_chat_soon.mjs` proves that with the area exported, picking the
place registers exactly ONE contribution with a render and clamped `{ opacity, dimApp }`, that Panel,
an Off and dispose call its disposer, and that Aura writes nothing into `document.body`, `<head>` or
`<html>`; and that without the area the pill is disabled and nothing is registered.
`tests/test_backdrop_lifecycle.mjs` covers the Off-in-flight, replaced-server and strength checks, and
`tests/test_no_backdrop.mjs` proves nothing at all is painted for any other surface.

### Polling

The desktop half keeps its 4 Hz tick but only reaches the backend when Aura is doing something:
switched on, a film or the visualiser on screen, radio or music playing, a desktop window open, or
ten seconds after a click or an agent request. Idle it asks every 3 s, and every 15 s while the
Hermes window is hidden. Counted by `tests/test_idle_poll.mjs` with a fake clock:

| Window | `/status` calls before | after |
|---|---|---|
| Aura off, nothing playing, visible, 10 s | 40 | 3 |
| Aura off, nothing playing, window hidden, 30 s | 120 | 2 |
| Aura on, 2 s | 8 | 8 |

While a film plays nothing changed: the surface owns the fast cadence, so the player, its
position and its volume are reported as often as before.

## What is *not* verified here

Player seek/resume, drag placement, and the look of the menus have not been recorded as
automated tests; they are exercised by hand. If something looks wrong in the app, that is a bug
report we want — the tests above cover plumbing, not taste.

## Playlist window

`Manage (☰)` hands a playlist to the pop-out window, which is ordinary Chromium on Aura's own
profile. Three tests pin the plumbing: a non-http(s) URL is refused before any process starts
(`tests/test_manage_window.py`), the window is only reused rather than doubled
(`tests/test_window.py::test_open_page_reuses_a_live_window`), and the pane sends the playlist page
itself, not the watch URL (`tests/test_desktop_plugin.mjs`). Whether Google allows the sign-in inside
that profile is **not** tested here — it depends on the account, and the button falls back to the
system browser.
