# Configuration

One line: every setting Aura actually reads, its default, and what it changes.

Applies to Aura 1.0.0 · revised 2026-11-13

Aura reads one JSON file and a small set of environment variables. Unknown
keys are ignored; wrong types fall back to the default. The file is written
atomically with mode `0600` (`aura_core/config.py`).

## Settings file

`~/.hermes/aura/config.json` (or under `HERMES_HOME`).

| Key | Type | Default | What it does |
|---|---|---|---|
| `enabled` | boolean | `false` | The kill switch. Off means no capture, no backdrop, no mood painting; hooks become no-ops. |
| `listen_background` | boolean | `false` | Keep analysing audio with no Aura page open. Off saves roughly 4% of one core when idle. |
| `intensity` | number 0..1 | `0.25` | Reaction strength: the fraction of the normalised audio reaction the visualizer draws. `0` draws no audio reaction, `1` the full level. First-run only. |
| `preset` | string or null | `null` | A named preset from `web/presets.json`; `null` lets the server pick. |
| `reduced_motion` | boolean | `false` | Lowers intensity, avoids strobe presets, disables the accent pulse. |
| `theme_opt_in` | boolean | `false` | Published in `/api/config` for compatibility; no renderer reads it at this commit. The host theme is only changed through the SDK's sanctioned accent path. |
| `opacity` | number 0..1 | `0.25` | Dims the canvas and its scrim together. Applied once, by the visualizer page; first-run only. |
| `behavior` | `calm` \| `balanced` \| `intense` | `balanced` | Named render profile; see the table below. |
| `mood_reactive` | boolean | `true` | Let agent moods pick scene, motion and reaction strength. |
| `accent_pulse` | boolean | `false` | Opt-in: pulse the host accent with the audio. |
| `auto_preset` | boolean | `true` | Allow automatic preset rotation/selection. |
| `motion` | `designs` \| `both` \| `music` \| `agent` \| `agent_music` | `agent_music` | What drives motion. `designs` is legacy but still accepted. |
| `idle_motion` | `stop` \| `ember` \| `always` | `always` | What the render gain does while the agent is idle/done. |

Behaviour profiles are concrete, not labels (`aura_core/behavior.py`):

| Profile | Intensity ceiling | Pulse cap | Preset family | Blend | Strobe |
|---|---|---|---|---|---|
| `calm` | 0.6 | 0 Hz (no hard pulse) | organic | 2400 ms | off |
| `balanced` | 1.0 | 1 Hz | liquid | 1200 ms | allowed |
| `intense` | 1.0 | 2 Hz | geometric | 600 ms | allowed |

## Plugin config read at register time

`__init__.py` reads two keys through Hermes' `ctx.get_config`:

| Key | Default there | Effect |
|---|---|---|
| `enabled` | `true` | Mirrors the kill switch before the config file is loaded. |
| `intensity` | `1.0` | Passed to the mood machine as the intensity cap. |

## Environment variables

| Variable | Default | Read in | Effect |
|---|---|---|---|
| `HERMES_HOME` | `~/.hermes` | `aura_core/config.py`, `dashboard/plugin_api.py` | Where `aura/` lives. A context-local Hermes override wins when the agent package is importable. |
| `AURA_CAPTURE` | unset | `aura_core/capture/base.py`, `aura_core/config.py` | Preferred backend: `pipewire`, `pulse`, `wasapi`, `macos`, or `none`. `none` disables capture (accent-only mode); unknown values are ignored. |
| `AURA_RADIO_BROWSER_SERVERS` | three public mirrors | `aura_core/radio.py` | Comma-separated Radio Browser mirrors. |
| `AURA_DESKTOP_BROWSER` | first Chromium-family browser on `PATH` | `aura_core/window.py` | Browser used for the pop-out window and playlist manager. |
| `AURA_DESKTOP_GPU` | unset | `aura_core/window.py` | `0` disables the Wayland ozone flag for the private browser profile. |
| `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY` | unset | `aura_core/window.py` | Detects Wayland to pass `--ozone-platform=wayland` to the window's browser. |

## Related files that are not settings

| File | Why it exists |
|---|---|
| `~/.hermes/aura/token` | Per-launch bearer token; rotate by restarting Aura. |
| `~/.hermes/aura/server.lock` | Leader-election lock (`fcntl.flock`, POSIX only). |
| `~/.hermes/aura/lease.json` | Leader advertisement read by followers and tools. |
| `~/.hermes/aura/radio_favorites.json` | Saved radio stations. |

The test suite also reads `AURA_TEST_OVERRIDE_HOME` to point a subprocess at a
temporary Hermes home; it is not a user setting.

Back to [docs/README.md](README.md).
