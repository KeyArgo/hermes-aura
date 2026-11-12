# Troubleshooting

One line: the failure modes Aura actually handles, what they look like, and what to try.

Applies to Aura 1.0.0 · revised 2026-11-11

## The visual is black or still

1. Check that Aura is enabled and the backend is **Aura visual**, not **Video
   player**.
2. Check the capture backend: the status tool (`aura_control action=status`)
   reports `capture`. On Linux it should read `pipewire` or `pulse`; `none`
   means no monitor was found.
3. Confirm the system is playing audio to the default sink. Aura reads the
   monitor of the default output, not a microphone.
4. If no page has been connected for 30 seconds, the capture loop deliberately
   drops to silence to save roughly 4% of one core (`IDLE_STOP_S` in
   `aura_core/server.py`). Open an Aura surface and it reopens. Set
   `listen_background` to keep it alive with nobody watching.
5. Try `AURA_CAPTURE=pulse` or `AURA_CAPTURE=pipewire` if both tools are
   installed and the wrong one was chosen.

## “System audio loopback is unavailable”

The page is still drawing ambient visuals; only reactivity is off. The cause is
one of: no PipeWire/PulseAudio running, no sink monitor, `parec`/`pw-record`
missing, or `AURA_CAPTURE=none`. Check with:

```bash
pactl list short sources | grep monitor
which parec pw-record
```

## Pop-out says no browser was found

The OS window needs Chrome, Chromium, Brave or Edge on `PATH`
(`aura_core/window.py`, `BROWSERS`). Install one, or point Aura at it:

```bash
AURA_DESKTOP_BROWSER=/path/to/chrome
```

If no browser is available, Aura can fall back to the in-app watch window; the
agent reports that instead of failing.

## A playlist item says “video unavailable” and the list stops

Aura resolves public playlists server-side and skips items that forbid
embedding or were deleted (`dashboard/plugin_api.py`, `playlistItems`). If every
item after the current one is unplayable, the list has nowhere to go. Private
playlists are not supported at all; use **Manage (☰)** to edit with your own
YouTube session.

## Radio search returns the starter list instead of results

Radio Browser was unreachable. Aura answers with its curated presets and sets a
`note`/`fallback` flag rather than an error (`aura_core/radio.py`). Try again
later, or override the mirrors:

```bash
AURA_RADIO_BROWSER_SERVERS=https://de1.api.radio-browser.info,https://de2.api.radio-browser.info
```

## “unauthorized” from the local server

The request lacks the current token. The token rotates when the server starts
and lives in `~/.hermes/aura/token`. Use the dashboard routes (which obtain the
token themselves) or pass `Authorization: Bearer <token>`. Do not put the token
in a screenshot or bug report.

## A stale Aura window is left after a restart

The window closes with the server by design: a window playing audio that
nothing can control is worse than a closed one (`aura_core/window.py`). If the
server was killed hard, close the window manually; the next `Pop out` opens a
fresh one.

## Two Aura servers seem to exist

On POSIX, one leader is elected with `fcntl.flock` and advertised in
`~/.hermes/aura/lease.json` (`aura_core/server.py`). On Windows the lock import
is guarded, so each process may keep its own server — a known limit
([LIMITS.md](../LIMITS.md)). Check the lease for the live port before assuming
a second server exists.

## The end-to-end visualiser test skipped

`tests/e2e/test_viz_e2e.py` needs a real headless Chrome and a free CPU to
sample the canvas. It skips rather than reporting a false failure on a loaded
host ([TESTING.md](../TESTING.md)). The desktop and Python suites still run.

## `hermes plugins validate` prints a warning

The single warning names a private-core import in `aura_core/sessions.py`, used
to count live chat sessions. It is inside a `try` with a file-based fallback, so
Aura works without it ([VERIFY.md](../VERIFY.md)).

## Reset the configuration

Delete `~/.hermes/aura/config.json`; Aura recreates it with defaults on the next
save. Deleting the whole `~/.hermes/aura/` directory also removes the token,
lease, lock and radio favourites. Do this while Aura is off.

Back to [docs/README.md](README.md).
