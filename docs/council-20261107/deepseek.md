[0m
> build · deepseek-v4.1-flash-free
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && find . -maxdepth 3 -type f -not -path './.git/*' -not -path '*/node_modules/*' | head -100
./__pycache__/__init__.cpython-314.pyc
./SPIKES.md
./.lanes-windows-TASK.md
./tests/__pycache__/test_null_capture_pacing.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_mood.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_behavior.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_hooks.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_analysis.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_capture.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_server.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_startup_concurrency.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_capture_namespaced_import.cpython-314-pytest-9.2.0.pyc
./tests/__pycache__/test_tool.cpython-314-pytest-9.2.0.pyc
./tests/test_capture_namespaced_import.py
./tests/test_mood.py
./tests/test_behavior.py
./tests/test_server.py
./tests/test_startup_concurrency.py
./tests/test_tool.py
./tests/test_hooks.py
./tests/integration/test_live_server_page.py
./tests/test_capture.py
./tests/e2e/debug_shifter.py
./tests/e2e/debug_mood_decay.py
./tests/e2e/probe_presets.py
./tests/e2e/debug_reissue.py
./tests/e2e/debug_decay_screen.py
./tests/e2e/all_presets.json
./tests/e2e/quick_results.json
./tests/e2e/test_viz_e2e.py
./tests/e2e/debug_black_tone.py
./tests/e2e/debug_boot_silence.py
./tests/e2e/default_screen.py
./tests/e2e/evidence_shots.py
./tests/e2e/test_display_controls_e2e.py
./tests/e2e/shot_results.json
./tests/e2e/deep_results.json
./tests/test_desktop_plugin.mjs
./tests/test_null_capture_pacing.py
./tests/test_analysis.py
./docs/council-20261107/codex.err
./docs/council-20261107/codex.md
./docs/council-20261107/grok.md
./docs/council-20261107/deepseek.md
./docs/council-20261107/BRIEF.md
./docs/PLAN-STUDIO.md
./docs/PUBLISH.md
./docs/STATUS.md
./aura_core/__pycache__/behavior.cpython-314.pyc
./aura_core/__pycache__/config.cpython-313.pyc
./aura_core/__pycache__/redact.cpython-313.pyc
./aura_core/__pycache__/__init__.cpython-314.pyc
./aura_core/__pycache__/analysis.cpython-313.pyc
./aura_core/__pycache__/__init__.cpython-313.pyc
./aura_core/__pycache__/behavior.cpython-313.pyc
./aura_core/__pycache__/mood.cpython-314.pyc
./aura_core/__pycache__/server.cpython-314.pyc
./aura_core/__pycache__/config.cpython-314.pyc
./aura_core/__pycache__/redact.cpython-314.pyc
./aura_core/__pycache__/analysis.cpython-314.pyc
./aura_core/__pycache__/server.cpython-313.pyc
./aura_core/behavior.py
./aura_core/server.py
./aura_core/config.py
./aura_core/analysis.py
./aura_core/redact.py
./aura_core/mood.py
./aura_core/capture/pipewire.py
./aura_core/capture/base.py
./aura_core/capture/wasapi.py
./aura_core/capture/macos.py
./aura_core/capture/pulse.py
./aura_core/capture/sd_common.py
./aura_core/capture/__init__.py
./aura_core/__init__.py
./.lanes-theme.log
./plugin.yaml
./pytest.ini
./dashboard/__pycache__/plugin_api.cpython-314.pyc
./dashboard/__pycache__/plugin_api.cpython-313.pyc
./dashboard/plugin_api.py
./dashboard/manifest.json
./.lanes-theme-TASK.md
./.demo/preset-scores.json
./.demo/hero-32.jpg
./.demo/hero-56.jpg
./.demo/aura-demo.mp4
./.demo/hero-44.jpg
./.demo/hero-08.jpg
./.demo/hero-20.jpg
./.demo/frames/f0052.jpg
./.demo/frames/f0103.jpg
./.demo/frames/f0146.jpg
./.demo/frames/f0114.jpg
./.demo/frames/f0188.jpg
./.demo/frames/f0226.jpg
./.demo/frames/f0270.jpg
./.demo/frames/f0140.jpg
./.demo/frames/f0217.jpg
./.demo/frames/f0197.jpg
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && git status --short | head -50 && echo "---FILES---" && ls -la
M README.md
 M aura_core/capture/base.py
 M aura_core/config.py
 M aura_core/server.py
 M desktop/plugin.js
 M docs/PUBLISH.md
 M docs/STATUS.md
 M tests/e2e/test_display_controls_e2e.py
 M tests/e2e/test_viz_e2e.py
 M tests/integration/test_live_server_page.py
 M tests/test_behavior.py
 M tests/test_desktop_plugin.mjs
 M tests/test_server.py
 M web/aura.js
 M web/index.html
?? .lanes-windows-TASK.md
?? dashboard/manifest.json
?? docs/PLAN-STUDIO.md
?? docs/council-20261107/
?? tests/test_capture_namespaced_import.py
?? tests/test_null_capture_pacing.py
?? tests/test_startup_concurrency.py
---FILES---
total 624
drwxr-xr-x   16 dev dev   4096 Nov  6 23:34 .
drwxrwx---+ 386 dev dev  20480 Nov  7 01:50 ..
drwxr-xr-x    4 dev dev   4096 Nov  6 22:02 aura_core
-rw-r--r--    1 dev dev  11692 Nov  5 03:26 CONTRACT.md
drwxr-xr-x    3 dev dev   4096 Nov  6 23:08 dashboard
drwxr-xr-x    3 dev dev   4096 Nov  5 03:40 .demo
drwxr-xr-x    2 dev dev   4096 Nov  7 02:01 desktop
drwxr-xr-x    3 dev dev   4096 Nov  7 02:17 docs
drwxr-xr-x    8 dev dev   4096 Nov  7 02:17 .git
-rw-r--r--    1 dev dev     94 Nov  5 03:33 .gitignore
-rw-r--r--    1 dev dev  18626 Nov  5 00:54 __init__.py
drwxr-xr-x    8 dev dev   4096 Nov  5 02:12 .lanes
-rw-r--r--    1 dev dev 181596 Nov  6 23:22 .lanes-overlay.log
-rw-r--r--    1 dev dev   3181 Nov  6 23:15 .lanes-overlay-TASK.md
-rw-r--r--    1 dev dev 286433 Nov  6 23:43 .lanes-theme.log
-rw-r--r--    1 dev dev   4432 Nov  6 23:33 .lanes-theme-TASK.md
-rw-r--r--    1 dev dev   2871 Nov  6 23:34 .lanes-windows-TASK.md
-rw-r--r--    1 dev dev    240 Nov  5 03:35 .last-test.log
-rw-r--r--    1 dev dev   1231 Nov  6 23:22 opencode.json
-rw-r--r--    1 dev dev   1177 Nov  5 03:27 plugin.yaml
drwxr-xr-x    2 dev dev   4096 Nov  5 00:54 __pycache__
drwxr-xr-x    3 dev dev   4096 Nov  5 00:56 .pytest_cache
-rw-r--r--    1 dev dev     40 Nov  4 22:30 pytest.ini
-rw-r--r--    1 dev dev   3263 Nov  6 23:41 README.md
drwxr-xr-x    3 dev dev   4096 Nov  4 16:53 .spike
-rw-r--r--    1 dev dev   3862 Nov  4 22:30 SPIKES.md
drwxr-xr-x    5 dev dev   4096 Nov  6 22:18 tests
-rw-r--r--    1 dev dev   1299 Nov  5 01:11 THIRD_PARTY_NOTICES.md
drwxr-xr-x    3 dev dev   4096 Nov  5 04:30 tools
drwxr-xr-x    5 dev dev   4096 Nov  4 22:26 .venv
drwxr-xr-x    3 dev dev   4096 Nov  6 13:02 web
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && cat docs/STATUS.md && echo "=====README=====" && cat README.md && echo "=====PLUGIN.YAML=====" && cat plugin.yaml
# Aura — build status

Machine-readable checklist for the 5-minute progress reports. Weights sum to 120 and are
normalised to 100 %. `done` is the honest completion fraction (0.0 = untouched, 1.0 = verified by
a real command, not by a claim). Remaining % = Σ(weight × (1 − done)) ÷ 120 × 100.

Deadline: hackathon submission **Nov 11, 17:00 EST**; catalog PR target **Nov 9**.
Repo: /mnt/homes/Development/hermes-aura (LOCAL git only — nothing pushed yet).

| # | item | weight | done | evidence / blocker |
|---|---|---|---|---|
| 1 | wire contract + spikes (S1–S5) | 5 | 1.0 | CONTRACT.md §1–§10, SPIKES.md with measured numbers |
| 2 | Linux loopback capture | 10 | 1.0 | S2 probe: 786432 bytes = 4.10 s stereo 48k, RMS rising |
| 3 | server, WS PCM, analysis, redaction | 10 | 1.0 | tests/test_server.py, test_analysis.py green |
| 4 | page, Butterchurn, curated presets | 12 | 0.95 | 21 presets measured; mood→family steering merged but only tested headless |
| 5 | desktop half (stage route, settings, accent pulse, theme) | 12 | 0.70 | stage exit and no status-bar contribution covered by desktop tests; stage unavailable in the real app |
| 6 | mood engine + agent hooks | 6 | 0.90 | mood.py + hooks; approval pulse and restore covered by e2e |
| 7 | display controls (opacity, behaviour, 3 switches) | 6 | 0.90 | L6 merged; verified headless + node contract test |
| 8 | silence gate (visual follows audio) | 4 | 1.0 | 21/21 presets dark in silence, mean 0, lit 0.000 |
| 9 | test suite (unit + e2e + integration) | 8 | 1.0 | 178 passed, exit 0 (log: .last-test.log); includes the silence-gate test and a tone-fed degrade test |
| 10 | Windows WASAPI loopback | 7 | 0.20 | implemented, never run on a real Windows machine |
| 11 | macOS capture | 5 | 0.30 | implemented, needs BlackHole/virtual device, unverified |
| 12 | in-app verification (accent pulse, theme restore, iframe sandbox) | 10 | 0.00 | structural only; needs the user to open Aura in Hermes |
| 13 | demo video + stills | 5 | 0.90 | .demo/aura-demo.mp4: 277 frames, 13.8 fps, curated presets, music-only showcase + mood tail; stills dense |
| 14 | docs, notices, plugin validation | 5 | 1.0 | README, THIRD_PARTY_NOTICES, `hermes plugins validate .` passes |
| 15 | publish: repo, catalog PR, X post, submission form | 10 | 0.20 | drafts ready in docs/PUBLISH.md (catalog YAML, PR body, blurb, X post); repo has no remote; every step needs the user's OK |
| 16 | cross-family review round | 5 | 0.30 | GLM (C/D) + DeepSeek (A/B) reviewers dispatched over the merged tree; findings pending |

## Remaining work, in order

1. Finish the full test run and commit the silence gate.
2. Re-record the demo against the curated preset set; capture the stills.
3. Refresh the staged desktop half and have the user open Aura (item 12 is the big unknown:
   accent pulse through `ctx.rest('/state')`, theme restore, iframe sandbox).
4. Windows verification (item 10) — the only claim that would otherwise be unearned.
5. Review round (item 16), then publish (item 15) with explicit approval.

## Rules for the reporter

- Report only what a command shows. If a test run is in flight, say so and quote the last result.
- Never mark an item done because a lane claimed it; only because a command here passed.
- Keep the report to: what changed since the last report, what remains (ordered), remaining %.
=====README=====
# Aura

A living, audio-reactive theme for Hermes Desktop. Aura listens to **system audio** —
whatever this computer is already playing, from any app — analyses it locally, and
drives a MilkDrop-compatible visualizer plus the app's accent colour from it. It also
reacts to the agent: thinking, tool runs, approval waits, errors and finishes each have
a mood.

REVamp only reacts to audio REVamp itself plays. Aura needs no account, no music
integration and no playback of its own: it works with anything the machine is playing.

## What it does (0.1)

- **Aura stage** — a full-window visualizer page (`/aura`, sidebar entry) with a
  Back to chat button and an optional compact pane.
- **Accent pulse** — Hermes's accent colour follows the music (≤ 4 Hz, derived from your
  *current* theme so it composes with whatever skin you use; restored on disable).
- **Agent moods** — thinking / tool / approval / error / streaming / done, with
  restore-on-clear so nothing latches.
- **Display controls** — opacity, background visibility, a behaviour profile (calm /
  balanced / intense; calm is reduced-motion-safe and never uses strobe presets), a motion
  source (designs only / designs + music / music only), and switches for agent-mood
  reactions, accent pulse and automatic preset rotation. Settable by you or by the agent.
- **Aura Live as a backdrop theme** — selecting the Aura Live theme puts the visualizer
  behind the app (one click-through iframe) and turns the panels into frosted glass using
  translucent versions of the active theme's own colours. Background visibility controls
  how much shows through; text stays crisp. Disabling the theme removes everything.
- **Motion that fits the room** — designs-only runs a quiet ambient source with no audio;
  designs + music follows playback and rests on the designs after 1.5 s of silence;
  music-only settles when nothing is playing.
- **Optional theme** — an Aura theme whose palette follows the audio. Opt-in; disabling
  restores the theme you had before.
- **`aura_control`** — the agent can turn Aura on/off, set reaction strength, opacity,
  behaviour and motion, pick a preset, set a mood.

## Privacy and safety

- Use the stage control or Aura settings to turn the visualizer off.
- Captures **loopback** (what the machine plays), never the microphone.
- Analysis happens in memory. Nothing is recorded to disk, nothing is sent anywhere.
- Aura never plays, pauses or ducks audio.
- Flash limiting, reduced-motion support, an intensity slider, and a scrim so chat text
  stays readable.

## Platform support (honest)

- **Linux:** PipeWire / PulseAudio monitor capture — tested.
- **Windows:** WASAPI loopback — implemented, needs a real-machine test before it is claimed.
- **macOS:** needs a virtual audio device (e.g. BlackHole) or tab audio; no native helper.

## Status

Pre-release (0.1.0). See `SPIKES.md` for what was actually measured, and `CONTRACT.md` for
the internal wire contract between the capture server, the page, the desktop half and the
agent hooks.

## Licences

Butterchurn (MIT) and a curated subset of butterchurn-presets (MIT package; individual
presets credited in `THIRD_PARTY_NOTICES.md`). "MilkDrop-compatible" — not MilkDrop itself.
=====PLUGIN.YAML=====
name: aura
label: Aura
kind: standalone
version: 0.1.1
author: Argo
description: >
  Aura turns Hermes Desktop into a living, audio-reactive space: it listens to what
  this computer is already playing (system loopback, never the microphone), draws a
  MilkDrop-compatible visualizer in an Aura stage, pulses the app accent with the
  music, and shifts mood with what the agent is doing — thinking, running tools,
  waiting for approval, erroring, finishing. It can also contribute an optional theme
  whose palette follows the audio, and the agent can set the room with the aura_control
  tool. Everything is analysed locally in memory: no account, no music integration, no
  recording, no audio leaves the machine. Aura never plays or ducks sound. Off until the
  user turns it on, one click to stop. See README.md for platform limits.
requires_hermes: ">=0.22.5"
license: MIT
provides_tools:
  - aura_control
provides_hooks:
  - on_session_start
  - on_session_end
  - pre_tool_call
  - post_tool_call
  - pre_approval_request
  - post_approval_response
  - api_request_error
  - on_stream_start
  - on_stream_end
  - subagent_start
  - subagent_stop
dashboard: dashboard
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && cat docs/PLAN-STUDIO.md
# Aura Studio plan: MilkDrop's controls, no stuck frame

Status: proposal, 2026-11-07. Owner approval needed before building. Hackathon deadline: 2026-11-11 15:00 Denver.

## Goal
- Aura Live is a **theme**: MilkDrop visuals behind the whole app (working as of 2026-11-07).
- Every control lives in one place, **Aura Studio**: a panel over the app that closes with X, Esc or
  a click outside. No permanent pane, no separate page.
- Bring over as much of MilkDrop's control set as the engine (Butterchurn) supports.

## How people open and close it
| Way in | What happens |
|---|---|
| Sidebar "Aura" | Opens Aura Studio (panel over the app, dimmed behind) |
| Command palette "Aura: Studio" / "Aura: next design" / "Aura: lock design" | Studio, or a direct action |
| Settings → Plugins → Aura | On/off, Aura Live theme switch, an "Open Aura Studio" button |
| `/skin aura-live` (built into Hermes) | Selects the theme; Studio can stay closed |
| X, Esc, or a click outside the panel | Closes Studio. Nothing stays open |

Removed: the /aura full page, the compact right-hand pane (closing a plugin's only pane can disable
the plugin in Hermes core), and the stage's in-page control bar.

## Studio layout (four tabs)
1. **Designs**: a live preview at the top. A browser with search, thumbnails, favourites (★),
   hide (🚫), previous/next/random, and **lock current design**.
2. **Transitions**: auto-switch on/off, the time between switches (seconds) plus randomness,
   shuffle vs. in order (favourites only, optionally), blend time, and **hard cuts on the beat** with
   beat sensitivity (MilkDrop's "hard cut" behaviour).
3. **Sound**: motion (Designs only / Designs + music / Music only), reaction strength, what it
   follows (bass / mids / highs / everything), settle speed, mood reactions to agent events, and the
   capture device.
4. **Look & window**: background visibility, colour mode (Aura purple / match my current theme /
   custom tint, plus hue, saturation and brightness), quality (mesh size, texture resolution,
   anti-aliasing, frame-rate cap), song-title style text for agent events (Butterchurn
   `launchSongTitleAnim`), calm/balanced/intense, and reduced motion.

## MilkDrop feature map (verified against the vendored Butterchurn API)
| MilkDrop option | Engine support | Effort |
|---|---|---|
| Preset browse / next / prev / random / lock | `loadPreset(preset, blendSeconds)` | easy |
| Favourites, hide, shuffle, favourites-only | Aura-side list logic | easy |
| Auto-switch time + randomness, blend time | Aura timer + `loadPreset` blend | easy |
| Hard cut on beat + sensitivity | Aura beat detector already has onsets → `loadPreset(p, 0)` | medium |
| Song-title animation | `launchSongTitleAnim(text)` | easy |
| Mesh size, texture size, FXAA, pixel ratio | `setInternalMeshSize`, `textureRatio`, `setOutputAA`, `pixelRatio` | easy |
| Brightness / hue / saturation | CSS filter on the canvas | easy |
| Frame-rate cap | Aura render loop | easy |
| More preset packs (beyond the ~100 shipped) | butterchurn-presets extra packs; **licence review first** | medium |
| Import your own .milk files | needs .milk→JSON conversion; HLSL shaders don't convert reliably | hard, phase 3 |
| Live preset editing (MilkDrop's editor) | not supported by the engine | no |
| Custom sprites / Winamp menus | not supported | no |

## Phases (built by Spark/DeepSeek lanes; Claude reviews, tests and checks on screen)
- **P1 Studio shell** (~½ day): panel over the app (X/Esc/outside click), sidebar/palette/settings
  entry points, remove page + pane, Designs tab with preview, browse, search, favourites and lock.
  *Done when:* the owner opens and closes it three ways, picks a design, and the backdrop changes.
- **P2 MilkDrop controls** (~1 day): Transitions + Sound + Look tabs, hard cuts on the beat, quality,
  colour modes, song-title text for agent events. Server config keys, validated, persisted.
  *Done when:* every control visibly changes the backdrop (screenshots before and after).
- **P3 Extras** (optional, after the deadline): more preset packs (licence), .milk import.
- **Windows** in parallel: soundcard capture lane (`.lanes-windows-TASK.md`) + owner test on the PC.

## Risks
- Theme glass and the backdrop rely on overriding Hermes CSS variables (no official backdrop API), so
  a Hermes Desktop update can break them. Mitigation: fall back to a plain theme; propose a backdrop
  slot upstream.
- Two Aura servers run today (gateway and plugin host) with a shared token file. Studio talks to
  whichever server `/status` returns; moving capture out of process fixes this properly later.
- GPU cost: the backdrop and the Studio preview both render. The preview pauses when Studio closes.
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '1,220p' desktop/plugin.js
/**
 * Aura — desktop half of the Aura Hermes plugin.
 *
 * Aura listens to what this computer is already playing and turns it into a
 * MilkDrop-compatible stage plus an audio-reactive accent. This file is ONLY
 * the desktop half: capture, analysis and the visualizer page belong to the
 * Python/server and web halves. The desktop half reaches them through the one
 * sanctioned door, `ctx.rest('/status')` and `ctx.rest('/control')`
 * (dashboard/plugin_api.py), and hands the returned tokenised URL straight to
 * an iframe.
 *
 * What it contributes (Hermes Desktop plugin SDK only — no core edits):
 *   - a full-page stage at /aura (`ROUTES_AREA`) hosting the visualizer,
 *   - a sidebar row (`SIDEBAR_NAV_AREA`) and a palette command (`PALETTE_AREA`),
 *   - a compact right-hand pane (`panes`) so the stage can sit beside chat,
 *   - an optional `THEMES_AREA` theme ('aura-live') the user must opt into,
 *   - a settings page (`SETTINGS_PLUGINS_AREA`) with enable / reaction strength /
 *     background visibility / motion / accent-follow / theme controls.
 *
 * The SDK has no backdrop slot (see SPIKES.md S1), so selecting the Aura Live
 * theme mounts one click-through iframe behind the app and injects a single
 * glass stylesheet: panels become translucent versions of the ACTIVE theme's
 * own colours while the visualizer sits behind them. The accent is still
 * pulsed by retinting that theme's accent — never by imposing a hue.
 *
 * Plain ESM, loaded uncompiled: `jsx()` calls only, no JSX syntax, no eval,
 * no dynamic import. Imports are limited to @hermes/plugin-sdk, react and
 * react/jsx-runtime. Every contribution and timer returns a disposer, and
 * `register()` returns one disposer that stops polling, clears the accent
 * override, restores the user's previous theme and removes every contribution.
 */

import {
  $accentOverride,
  atom,
  Button,
  host,
  PALETTE_AREA,
  PANES_AREA,
  requestTheme,
  ROUTES_AREA,
  setAccentOverride,
  SETTINGS_PLUGINS_AREA,
  SIDEBAR_NAV_AREA,
  StatusDot,
  Switch,
  THEMES_AREA,
  TITLEBAR_AREAS,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'aura'
const ROUTE = '/aura'
const THEME_NAME = 'aura-live'
// The contract says /api/state is cheap and safe at <= 4 Hz. One tick is one
// poll of /status (plus /state only while Aura is enabled), and the accent is
// re-applied at most once per tick, so the app never repaints faster than 4 Hz.
const POLL_MS = 250
const ACCENT_MIN_GAP_MS = 250
// Attention moods (approval/error) must not pulse faster than 2 Hz (CONTRACT §4).
const ATTENTION_MIN_GAP_MS = 500
const ACCENT_L_MIN = 0.34
const ACCENT_L_MAX = 0.78

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  intensity: 0.5,
  opacity: 0.75,
  behavior: 'balanced',
  moodReactive: true,
  accentPulse: true,
  autoPreset: true,
  themeOptIn: false,
  glass: 0.35,
  motion: 'both'
})

const GLASS_MIN = 0.05
const GLASS_MAX = 0.9

const BEHAVIORS = ['calm', 'balanced', 'intense']
const MOTIONS = ['designs', 'both', 'music']
const MOTION_LABELS = { designs: 'Designs only', both: 'Designs + music', music: 'Music only' }

const EMPTY_LIVE = Object.freeze({
  ok: false,
  port: null,
  url: '',
  capture: '',
  enabled: false,
  error: '',
  mood: '',
  at: 0
})

// ------------------------------------------------------------------ utilities

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

const clamp01 = value => {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0
}

const clampGlass = value => {
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, GLASS_MIN, GLASS_MAX) : DEFAULT_SETTINGS.glass
}

/** Normalise #rgb/#rrggbb/#rrggbbaa to a lowercase #rrggbb, or null. */
function normalizeHex(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const short = /^#([0-9a-f]{3})$/i.exec(raw)
  if (short) {
    const [r, g, b] = short[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw)
  return long ? `#${long[1]}`.toLowerCase() : null
}

function hexToHsl(hex) {
  const clean = normalizeHex(hex)
  if (!clean) return null
  const r = parseInt(clean.slice(1, 3), 16) / 255
  const g = parseInt(clean.slice(3, 5), 16) / 255
  const b = parseInt(clean.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return { h, s, l }
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp(s, 0, 1)
  const lum = clamp(l, 0, 1)
  const c = (1 - Math.abs(2 * lum - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lum - c / 2
  let rgb
  if (hue < 60) rgb = [c, x, 0]
  else if (hue < 120) rgb = [x, c, 0]
  else if (hue < 180) rgb = [0, c, x]
  else if (hue < 240) rgb = [0, x, c]
  else if (hue < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
}

// The renderer always has a document; a headless import (the contract test)
// does not, so every DOM touch is guarded.
const doc = typeof document !== 'undefined' ? document : null

/** Read the theme's published accent token. Never queries app markup. */
function readCssAccent() {
  if (!doc || typeof getComputedStyle !== 'function') return null
  try {
    return normalizeHex(getComputedStyle(doc.documentElement).getPropertyValue('--ui-accent'))
  } catch {
    return null
  }
}

function accentOf(theme) {
  const colors = theme && theme.colors
  if (!colors || typeof colors !== 'object') return ''
  return normalizeHex(colors.accent) || normalizeHex(colors.primary) || normalizeHex(colors.ring) || ''
}

// ------------------------------------------------------------- module state
// Reset by register() so a hot reload starts from a clean slate.

let ctxRef = null
let disposed = false
let pollDisposer = null
let polling = false
let liveFrame = null // latest /state frame — hot path, deliberately not an atom
let liveKey = ''
let backdropEl = null
let backdropUrl = ''
let glassStyleEl = null
let overrideActive = false
let lastAccentHex = null
let lastAccentAt = 0
let prevTheme = null
let themeInfo = { name: '', accent: '' }
let knownTheme = ''
const disposers = []

const $settings = atom({ ...DEFAULT_SETTINGS })
const $live = atom({ ...EMPTY_LIVE })
const $themeApplied = atom(false)

// --------------------------------------------------------------- persistence

function readSettings(ctx) {
  const out = { ...DEFAULT_SETTINGS }
  let raw = null
  try {
    raw = ctx.storage.get('settings', null)
  } catch {
    raw = null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (Number.isFinite(raw.intensity)) out.intensity = clamp01(raw.intensity)
    if (Number.isFinite(raw.opacity)) out.opacity = clamp01(raw.opacity)
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && wc -l web/aura.js aura_core/*.py desktop/plugin.js && echo "---mood---" && sed -n '1,160p' aura_core/mood.py
1976 web/aura.js
   306 aura_core/analysis.py
   108 aura_core/behavior.py
   253 aura_core/config.py
     0 aura_core/__init__.py
   315 aura_core/mood.py
   100 aura_core/redact.py
  1175 aura_core/server.py
  1373 desktop/plugin.js
  5606 total
---mood---
"""Aura mood state machine (L4 owns this file, CONTRACT.md §4).

Pure Python, stdlib only, no I/O and no module-level mutable state.  All time
comes from an injected monotonic clock, so the whole machine is deterministic
in tests.

Rules implemented here (CONTRACT.md §4):

* ``approval`` and ``error`` are attention moods: intensity is at least 0.6,
  the pulse rate never exceeds 2 Hz, and their ttl is finite and capped, so
  they expire back to the previous non-attention mood (restore-on-clear)
  instead of latching forever.
* ``done`` is a short settle (never longer than 1.5 s) that falls to ``idle``.
* ``reset()`` clears every trace, so a re-enable starts at ``idle``.
* Every mood carries ``flash_allowed`` for the visualizer.

The machine never changes audio; it only describes what the agent is doing.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

__all__ = [
    "MOODS",
    "ATTENTION_MOODS",
    "FLASH_ALLOWED",
    "PULSE_HZ",
    "DEFAULT_INTENSITY",
    "DEFAULT_TTL_MS",
    "MAX_PULSE_HZ",
    "ATTENTION_FLOOR",
    "ATTENTION_MAX_TTL_MS",
    "DONE_MAX_TTL_MS",
    "MoodState",
    "MoodMachine",
]

MOODS = ("idle", "thinking", "tool", "approval", "error", "streaming", "done")

ATTENTION_MOODS = frozenset({"approval", "error"})

#: Moods whose transition may flash the stage.  Attention moods may flash, but
#: their pulse is capped at MAX_PULSE_HZ so the flash never becomes a strobe.
FLASH_ALLOWED = {
    "idle": False,
    "thinking": False,
    "tool": False,
    "approval": True,
    "error": True,
    "streaming": False,
    "done": True,
}

#: Nominal pulse rate per mood (Hz).  Attention moods are additionally clamped
#: to MAX_PULSE_HZ at build time.
PULSE_HZ = {
    "idle": 0.0,
    "thinking": 0.5,
    "tool": 1.0,
    "approval": 2.0,
    "error": 2.0,
    "streaming": 0.5,
    "done": 0.0,
}

DEFAULT_INTENSITY = {
    "idle": 0.0,
    "thinking": 0.35,
    "tool": 0.50,
    "approval": 0.80,
    "error": 0.90,
    "streaming": 0.60,
    "done": 0.70,
}

#: Default lifetime of a mood before it expires.  ``done`` is clamped to
#: DONE_MAX_TTL_MS and attention moods to ATTENTION_MAX_TTL_MS.
DEFAULT_TTL_MS = {
    "idle": 0,
    "thinking": 180_000,
    "tool": 60_000,
    "approval": 30_000,
    "error": 15_000,
    "streaming": 1_800_000,
    "done": 1_500,
}

MAX_PULSE_HZ = 2.0
ATTENTION_FLOOR = 0.6
ATTENTION_MAX_TTL_MS = 60_000
DONE_MAX_TTL_MS = 1_500


def _as_float(value, default):
    if isinstance(value, bool) or value is None:
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _clamp01(value):
    return max(0.0, min(1.0, value))


@dataclass(frozen=True)
class MoodState:
    """Immutable snapshot of one mood transition."""

    mood: str
    intensity: float
    ttl_ms: int
    pulse_hz: float
    flash_allowed: bool
    since_ms: int
    expires_at_ms: int | None
    restore_mood: str | None
    revision: int

    def as_dict(self) -> dict:
        return {
            "mood": self.mood,
            "intensity": self.intensity,
            "ttl_ms": self.ttl_ms,
            "pulse_hz": self.pulse_hz,
            "flash_allowed": self.flash_allowed,
            "since_ms": self.since_ms,
            "expires_at_ms": self.expires_at_ms,
            "restore_mood": self.restore_mood,
            "revision": self.revision,
        }


class MoodMachine:
    """Clock-injectable mood state machine.

    ``clock`` is a callable returning monotonic seconds.  Tests pass a fake
    clock; production passes ``time.monotonic``.
    """

    def __init__(self, clock=None, intensity_cap: float = 1.0):
        self._clock = clock if clock is not None else time.monotonic
        self._lock = threading.RLock()
        self._cap = _clamp01(_as_float(intensity_cap, 1.0))
        self._revision = 0
        self._restore = None
        self._state = MoodState(
            mood="idle",
            intensity=0.0,
            ttl_ms=0,
            pulse_hz=0.0,
            flash_allowed=False,
            since_ms=self._now_ms(),
            expires_at_ms=None,
            restore_mood=None,
            revision=0,
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "def on_\|def pre_\|def post_\|def subagent\|mood" __init__.py | head -80
4:activity into mood transitions, then hands those transitions to
5:``aura_core.server.publish_mood`` (CONTRACT.md §4 and §7).
19:  the mood machine is reset.
42:    from .aura_core import mood as _mood, server as _server
45:        from aura_core import mood as _mood, server as _server
47:        _mood = None  # type: ignore[assignment]
58:_MOODS = tuple(getattr(_mood, "MOODS", ())) if _mood is not None else ()
59:_MACHINE = _mood.MoodMachine() if _mood is not None else None
74:_ACTIONS = ("on", "off", "status", "intensity", "preset", "mood")
122:    publish_mood = getattr(_server, "publish_mood", None)
123:    if publish_mood is None:
126:        publish_mood(str(state.mood), float(state.intensity), int(state.ttl_ms))
128:        logger.debug("aura: publish_mood failed", exc_info=True)
139:def _transition(mood: str, **kwargs):
142:    state = _MACHINE.set(mood, **kwargs)
295:    if _MACHINE.snapshot().mood == "approval":
354:    mood = state.mood if state is not None else "idle"
363:            "mood": mood,
375:        "mood": mood,
387:        if isinstance(live.get("mood"), str):
388:            payload["mood"] = live["mood"]
465:def _action_mood(args: dict) -> dict:
466:    raw = args.get("mood")
468:        return {"ok": False, "error": f"mood must be one of {list(_MOODS)}",
469:                "allowed_moods": list(_MOODS)}
470:    mood = raw.strip().lower()
472:        return {"ok": False, "error": "mood machine unavailable"}
473:    state = _MACHINE.set(mood)
477:        "mood": state.mood,
487:    """aura_control — turn Aura on/off, read status, set intensity/preset/mood."""
504:        else:  # mood
505:            payload = _action_mood(args)
516:        "port, capture backend, current mood and intensity, and a redacted URL. "
518:        "visualizer preset (null = server default); mood sets the agent mood "
540:            "mood": {
543:                "description": "for mood: the mood to display",
561:    """Register the aura_control tool and the mood observer hooks."""
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "mood\|approval\|error\|done\|thinking\|tool" web/aura.js | head -60
8: * only. Mood events drive intensity/brightness/pulse/tint; mood never touches the
39:  const MOODS = ['idle', 'thinking', 'tool', 'approval', 'error', 'streaming', 'done'];
40:  const ATTENTION = ['approval', 'error'];
45:  const DONE_SETTLE_MS = 1500;       // contract: done settles for ≤1.5 s
56:      mood_gain_scale: 0.35,
65:      mood_gain_scale: 1.0,
74:      mood_gain_scale: 1.35,
83:    errors: [],
95:    moodReactive: true,
166:    state.errors.push(text);
167:    if (state.errors.length > 50) state.errors.shift();
171:  window.addEventListener('error', (e) => {
172:    recordError(e.message || 'script error');
187:      return { status: 0, ok: false, json: null, error: String(e) };
351:  // mood engine
359:  // setRendererSize / connectAudio) and is never patched — mood shape comes
363:    thinking:  { gain: 1.30, bright: 0.14, tint: 0.00, pulse: 'breathe',   floor: 0, fx: { saturate: 1.08, contrast: 1.06 } },
364:    tool:      { gain: 1.12, bright: 0.04, tint: 0.00, pulse: 'none',      floor: 0, fx: { saturate: 1.03, contrast: 1.02 } },
365:    approval:  { gain: 1.15, bright: 0.08, tint: 0.00, pulse: 'attention', floor: 0.6, fx: { saturate: 1.12, contrast: 1.14 } },
366:    error:     { gain: 1.00, bright: 0.00, tint: 0.30, pulse: 'attention', floor: 0.6, fx: { saturate: 1.06, contrast: 1.08 } },
368:    done:      { gain: 0.95, bright: 0.02, tint: 0.00, pulse: 'settle',    floor: 0, fx: { saturate: 1.00, contrast: 1.00 } }
371:  // Preset families (web/presets.json `family`) that express each mood.
372:  // null = keep whatever is playing (transient moods). Attention moods blend
376:    thinking: ['geometric', 'fractal'],
377:    tool: null,
378:    approval: ['cosmic', 'geometric'],
379:    error: ['liquid', 'cosmic'],
381:    done: null
383:  const MOOD_BLEND_MS = 2200; // mood-driven preset changes crossfade, never cut
385:  const mood = {
396:  const moodRot = Object.create(null); // per-mood preset rotation
398:  function moodMod() { return MOOD_MOD[mood.current] || MOOD_MOD.idle; }
405:    if (mood.pulse) { clearInterval(mood.pulse); mood.pulse = null; }
411:    const mod = moodMod();
416:    // no hard pulses at all, but the attention mood is still visible.
418:      mood.pulsePeriod = 0;
424:      mood.pulsePeriod = 4000;
425:      mood.pulse = setInterval(() => {
429:      }, mood.pulsePeriod);
434:    mood.pulsePeriod = Math.max(500, Math.round(1000 / profile.pulse_hz_max));
435:    mood.pulse = setInterval(() => {
439:    }, mood.pulsePeriod);
457:    // mood_reactive=false: the agent-mood layer is off, so every incoming
458:    // mood is treated as idle. Nothing latches; turning it back on applies
459:    // the next mood event without a reload.
460:    if (!state.moodReactive) name = 'idle';
461:    const previous = mood.current;
466:      mood.previous = previous === 'idle' ? 'idle' : previous;
468:    if (name === 'idle') mood.previous = 'idle';
470:    mood.current = name;
471:    mood.lastAt = now();
472:    mood.serverIntensity = clamp(num(intensity, 0), 0, 1);
473:    mood.ttl = clamp(num(ttlMs, 0), 0, 60000);
474:    if (mood.expiry) { clearTimeout(mood.expiry); mood.expiry = null; }
476:    if (name === 'done') {
477:      // One short settle, then idle. Never latched — and a repeated "done" from
479:      if (previous !== 'done') {
480:        if (mood.settle) { clearTimeout(mood.settle); mood.settle = null; }
481:        mood.settle = setTimeout(() => {
482:          if (mood.current === 'done') applyMood('idle', 0, 0);
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '1,120p' docs/council-20261107/BRIEF.md
# Council brief: how does Aura become the #1 entry?

You are one voice in a 4-model council (Codex, Grok, DeepSeek V4.1 Flash, Claude). Answer independently.
READ-ONLY: do not edit, create, run installs, or start/stop anything. Reading files in this repo is fine.
Answer in <= 600 words, plain language, ranked recommendations, each with "why it moves the score" and
"rough effort (hours)". Be concrete and skeptical; disagree with the brief where you think it's wrong.

## The contest
Nous Research Hermes plugin hackathon, due 2026-11-11 15:00 America/Denver (~4 days). Judged on four
criteria, 25 points each: Usefulness, Reliability, Polish, Creativity. A competitor-watch sample (two
models scoring short excerpts) put Aura at 80/100 (Usefulness 20, Reliability 20, Polish 17.5,
Creativity 22.5) vs 82.5 for the sample leaders. Treat that as weak signal only.

Competitor-watch advice (summarised): the unique thing is visuals that react to music AND to what the
Hermes agent is doing (thinking, tools, approval requests, errors, finishing). Prove the full flow in
the real app; make the agent reaction the memorable demo moment (works even with video muted); make it
safe to live with (obvious off switch, reduced motion, flash limits, readable chat, failure cases);
claim only Linux unless Windows/macOS are really tested; do a clean-install rehearsal on the exact
submission revision.

## What Aura is now (repo: /mnt/homes/Development/hermes-aura, local git, uncommitted work)
- Hermes plugin: Python server captures system audio (pipewire/pulse on Linux; Windows backend
  unverified; macOS needs BlackHole) → analysis → WebSocket → Butterchurn (MilkDrop in WebGL) page.
- Agent hooks set a "mood" (thinking / tool / approval / error / done) that steers presets/accent.
- As of 2026-11-07 it WORKS in the real Hermes Desktop on Linux: "Aura Live" theme puts animated
  MilkDrop behind the whole app (click-through iframe at z-index -1 + translucent panels), motion
  modes (Designs only / Designs+music / Music only), background visibility, reaction strength,
  calm/balanced/intense. Tonight's fixes: capture busy-loop that froze the gateway, backend import bug
  (capture never worked in Hermes), missing dashboard manifest (stage never loaded), autoplay lock in
  the click-through backdrop, stale enabled flag.
- Known weak spots: relies on overriding Hermes CSS variables (no official backdrop API); two Aura
  server instances run (gateway + plugin host); capture runs inside the gateway (~4% CPU, more with
  music); a separate stage page + side pane still exist (owner wants them gone).
- Owner wants: "Aura Studio" — a closable panel (X / Esc / click outside) to preview and design the
  look, with MilkDrop's controls (preset browse/search/favourites/lock, auto-switch + blend, hard cut
  on beat, quality, colour). Plan: docs/PLAN-STUDIO.md. The owner's other plugin REVamp
  (/mnt/homes/Development/revamp, web/player.js ~L737-790) embeds Webamp's MilkDrop with the controls
  they like.

## Questions
1. What 3-5 things, done by the deadline, most raise the judged score? Rank them.
2. Studio vs. agent-aware demo vs. reliability hardening: how should ~4 days be split?
3. What should be CUT or not claimed?
4. The single 60-second demo script you'd submit.
5. One risk the owner is probably not seeing.
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '100,320p' __init__.py
def _port() -> int | None:
    if _server is None:
        return None
    get_port = getattr(_server, "get_port", None)
    if get_port is None:
        return None
    try:
        port = get_port()
    except Exception:  # noqa: BLE001
        return None
    if not port:
        return None
    try:
        return int(port)
    except (TypeError, ValueError):
        return None


def _publish(state) -> None:
    """Hand one transition to the server; never raises into a hook."""
    if _server is None or state is None:
        return
    publish_mood = getattr(_server, "publish_mood", None)
    if publish_mood is None:
        return
    try:
        publish_mood(str(state.mood), float(state.intensity), int(state.ttl_ms))
    except Exception:  # noqa: BLE001 — a closed socket must not break a turn
        logger.debug("aura: publish_mood failed", exc_info=True)


def _publish_config() -> None:
    if _server is None:
        return
    fn = getattr(_server, "publish_config", None)
    if fn is not None:
        fn()


def _transition(mood: str, **kwargs):
    if _MACHINE is None:
        return None
    state = _MACHINE.set(mood, **kwargs)
    _publish(state)
    return state


# ---------------------------------------------------------------------------
# token / redaction / HTTP (never guess a port)
# ---------------------------------------------------------------------------

def _token_path() -> Path:
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    return base.joinpath(*_TOKEN_FILE)


def _token() -> str | None:
    try:
        value = _token_path().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _mask_url(url: str) -> str:
    """Redact the token from a URL before it reaches the model."""
    text = str(url)
    if _redact_url is not None:
        try:
            return _redact_url(text)
        except Exception:  # noqa: BLE001
            pass
    return _TOKEN_RE.sub(r"\1***", text)


def _public_url(port: int) -> str:
    token = _token()
    url = f"http://127.0.0.1:{int(port)}/"
    if token:
        url += f"?token={token}"
    return _mask_url(url)


def _request(method: str, path: str, body: dict | None = None,
             timeout: float = 2.0) -> dict:
    """Call the live server.  The port comes from ``get_port()`` only."""
    port = _port()
    if not port:
        raise RuntimeError("server not running")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _get(path: str) -> dict:
    try:
        return _request("GET", path)
    except Exception:  # noqa: BLE001
        return {}


def _control(body: dict) -> dict:
    return _request("POST", "/api/control", body=body)


# ---------------------------------------------------------------------------
# config / kill switch
# ---------------------------------------------------------------------------

def _set_enabled(flag: bool) -> None:
    """Kill switch.  Enabling and disabling both start from a clean idle."""
    _CFG.enabled = bool(flag)
    if _MACHINE is not None:
        _MACHINE.reset()


def _persist_enabled(flag: bool) -> None:
    ctx = _CTX
    if ctx is None:
        return
    set_config = getattr(ctx, "set_config", None)
    if set_config is None:
        return
    try:
        set_config("enabled", bool(flag))
    except Exception:  # noqa: BLE001 — managed installs may refuse writes
        pass


# ---------------------------------------------------------------------------
# hooks — observers only; never raise, never return a dict
# ---------------------------------------------------------------------------

def _safe(fn):
    @functools.wraps(fn)
    def guarded(**kwargs):
        try:
            if not _CFG.enabled or _MACHINE is None:
                return None
            fn(**kwargs)
        except Exception:  # noqa: BLE001 — a hook must never break the turn
            logger.warning("aura: hook %s failed", fn.__name__, exc_info=True)
        return None

    return guarded


@_safe
def _hook_session_start(**kw) -> None:
    # A fresh session starts at idle; nothing from a previous session survives.
    _MACHINE.reset()
    _transition("idle")


@_safe
def _hook_session_end(**kw) -> None:
    _MACHINE.reset()
    _transition("idle")


@_safe
def _hook_pre_tool_call(**kw) -> None:
    _transition("tool")


@_safe
def _hook_post_tool_call(**kw) -> None:
    error_message = kw.get("error_message")
    status = str(kw.get("status") or "").strip().lower()
    failed = bool(error_message) or status in ("error", "failed", "failure") \
        or kw.get("ok") is False
    _transition("error" if failed else "thinking")


@_safe
def _hook_pre_approval_request(**kw) -> None:
    _transition("approval")


@_safe
def _hook_post_approval_response(**kw) -> None:
    # Only an active approval needs clearing; otherwise this is a no-op.
    if _MACHINE.snapshot().mood == "approval":
        _publish(_MACHINE.clear("approval"))


@_safe
def _hook_api_request_error(**kw) -> None:
    _transition("error")


@_safe
def _hook_on_stream_start(**kw) -> None:
    _transition("streaming")


@_safe
def _hook_on_stream_end(**kw) -> None:
    _transition("done")


@_safe
def _hook_subagent_start(**kw) -> None:
    _transition("thinking")


@_safe
def _hook_subagent_stop(**kw) -> None:
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '540,720p' __init__.py && echo "===dashboard manifest===" && cat dashboard/manifest.json
"mood": {
                "type": "string",
                "enum": list(_MOODS),
                "description": "for mood: the mood to display",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}

TOOLS = (
    ("aura_control", SCHEMA_AURA_CONTROL, _tool_aura_control),
)


# ---------------------------------------------------------------------------
# plugin entry point
# ---------------------------------------------------------------------------

def register(ctx: Any) -> None:
    """Register the aura_control tool and the mood observer hooks."""
    global _CTX
    _CTX = ctx

    try:
        enabled = ctx.get_config("enabled", True)
        _CFG.enabled = bool(enabled)
    except Exception:  # noqa: BLE001
        _CFG.enabled = True

    try:
        cap = ctx.get_config("intensity", 1.0)
        if _MACHINE is not None and isinstance(cap, (int, float)) \
                and not isinstance(cap, bool):
            _CFG.intensity_cap = max(0.0, min(1.0, float(cap)))
            _MACHINE.set_cap(_CFG.intensity_cap)
    except Exception:  # noqa: BLE001
        pass

    if not _CFG.enabled and _MACHINE is not None:
        _MACHINE.reset()

    for name, schema, handler in TOOLS:
        try:
            ctx.register_tool(name=name, toolset=TOOLSET, schema=schema,
                              handler=handler)
        except TypeError:
            # Older cores: positional name/schema/handler without toolset.
            ctx.register_tool(name=name, schema=schema, handler=handler)

    for hook_name, fn in HOOKS:
        ctx.register_hook(hook_name, fn)

    # Warm the server without blocking register().
    threading.Thread(target=_boot, name="aura-boot", daemon=True).start()
    logger.info("aura registered (%d tool, %d hooks)", len(TOOLS), len(HOOKS))


__all__ = ["register"]
===dashboard manifest===
{
  "name": "aura",
  "api": "plugin_api.py"
}
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "pane\|Pane\|SIDEBAR\|ROUTES\|THEMES\|PALETTE\|backdrop\|iframe" desktop/plugin.js | head -60
10: * an iframe.
13: *   - a full-page stage at /aura (`ROUTES_AREA`) hosting the visualizer,
14: *   - a sidebar row (`SIDEBAR_NAV_AREA`) and a palette command (`PALETTE_AREA`),
15: *   - a compact right-hand pane (`panes`) so the stage can sit beside chat,
16: *   - an optional `THEMES_AREA` theme ('aura-live') the user must opt into,
20: * The SDK has no backdrop slot (see SPIKES.md S1), so selecting the Aura Live
21: * theme mounts one click-through iframe behind the app and injects a single
22: * glass stylesheet: panels become translucent versions of the ACTIVE theme's
38:  PALETTE_AREA,
41:  ROUTES_AREA,
44:  SIDEBAR_NAV_AREA,
47:  THEMES_AREA,
192:let backdropEl = null
193:let backdropUrl = ''
258:// ------------------------------------------------------------- backdrop theme
259:// The active `aura-live` theme turns the visualizer into the app's backdrop:
260:// one click-through iframe behind every panel (z-index -1). Panels stay opaque
264:function backdropSrc(url) {
321:// Panels stack (window bg under chrome under chat surface), so translucency
323:// visibility is set in ONE place: the backdrop's opacity over the theme's own
351:  if (backdropEl) backdropEl.style.opacity = String(clampGlass(glass))
369:  if (backdropEl) {
371:      backdropEl.remove()
374:        if (backdropEl.parentNode) backdropEl.parentNode.removeChild(backdropEl)
380:  backdropEl = null
381:  backdropUrl = ''
385:/** Keep exactly one backdrop mounted, in sync with the theme and live status. */
390:  // The server's enabled flag is the truth (the pane uses it too); the local
391:  // copy can be stale, which silently kept the backdrop away.
399:  const src = backdropSrc(url)
400:  if (!backdropEl) {
402:    backdropEl = doc.createElement('iframe')
403:    backdropEl.setAttribute('aria-hidden', 'true')
404:    backdropEl.setAttribute('tabindex', '-1')
405:    backdropEl.setAttribute('title', 'Aura backdrop')
407:    backdropEl.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads')
408:    backdropEl.setAttribute('referrerpolicy', 'no-referrer')
409:    backdropEl.setAttribute('allow', 'autoplay; fullscreen')
410:    backdropEl.setAttribute('allowfullscreen', '')
411:    const style = backdropEl.style
421:    backdropUrl = src
422:    backdropEl.src = src
423:  } else if (backdropUrl !== src) {
424:    backdropUrl = src
425:    backdropEl.src = src
427:  if (backdropEl.parentNode !== doc.body) doc.body.appendChild(backdropEl)
712:  return jsx('iframe', {
916:          'Listens to system audio and drives the stage, the pane and the accent.',
986:          'How much the Aura visuals show through the frosted panels. Lower keeps text crisp.',
1235:    // A hot reload must not inherit a stale backdrop from the previous instance.
1261:        area: ROUTES_AREA,
1271:        area: SIDEBAR_NAV_AREA,
1279:        area: PALETTE_AREA,
1297:        id: 'pane',
1302:          dock: { pane: 'workspace', pos: 'right' },
1324:        area: THEMES_AREA,
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -rn "studio\|Studio\|Aura Studio" --include=*.js --include=*.py --include=*.html --include=*.json . | grep -v node_modules | head -20; echo "---dashboard api---"; sed -n '1,120p' dashboard/plugin_api.py
./.venv/lib/python3.14/site-packages/pygments/styles/_mapping.py:52:    'VisualStudioStyle': ('pygments.styles.vs', 'vs', ()),
./.venv/lib/python3.14/site-packages/pygments/styles/vs.py:5:    Simple style with MS Visual Studio colors.
./.venv/lib/python3.14/site-packages/pygments/styles/vs.py:16:__all__ = ['VisualStudioStyle']
./.venv/lib/python3.14/site-packages/pygments/styles/vs.py:19:class VisualStudioStyle(Style):
./.venv/lib/python3.14/site-packages/pygments/styles/nord.py:5:    pygments version of the "nord" theme by Arctic Ice Studio
./.venv/lib/python3.14/site-packages/pygments/styles/nord.py:22:    Pygments version of the "nord" theme by Arctic Ice Studio.
./.venv/lib/python3.14/site-packages/pygments/styles/nord.py:92:    Pygments version of a darker "nord" theme by Arctic Ice Studio
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:750:    including `AppleScript Studio
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:752:    Reference/StudioReference>`_.
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:823:    StudioClasses = ('action cell', 'alert reply', 'application', 'box',
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:839:    StudioEvents = ('accept outline drop', 'accept table drop', 'action',
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:883:    StudioCommands = ('animate', 'append', 'call method', 'center',
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:894:    StudioProperties = ('accepts arrow key', 'action method', 'active',
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:1038:             r'({})'.format('|'.join(StudioEvents[::-1])),
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:1050:            (r'\b({})\b'.format('|'.join(StudioProperties)), Name.Attribute),
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:1051:            (r'\b({})s?\b'.format('|'.join(StudioClasses)), Name.Builtin),
./.venv/lib/python3.14/site-packages/pygments/lexers/scripting.py:1052:            (r'\b({})\b'.format('|'.join(StudioCommands)), Name.Builtin),
./.venv/lib/python3.14/site-packages/pygments/lexers/foxpro.py:32:    url = 'https://learn.microsoft.com/en-us/previous-versions/visualstudio/foxpro'
./.venv/lib/python3.14/site-packages/pip/_vendor/pygments/styles/_mapping.py:51:    'VisualStudioStyle': ('pygments.styles.vs', 'vs', ()),
./.venv/lib/python3.14/site-packages/pip/_vendor/rich/_emoji_codes.py:2216:    "studio_microphone": "🎙",
---dashboard api---
"""Aura Hermes Desktop dashboard API — the single port-discovery door (§5).

The desktop half and the agent tool must never guess a port, read a lease file
or start a second server. This module asks the *already imported* server module
for its live port and token, and forwards control calls to it.

Import strategy (follows REVamp's plugin glue): the plugin may be loaded as a
package (``aura``) or as a plain directory, so the server module is located by
scanning ``sys.modules`` first, then by relative/absolute import, and only as a
last resort by file path. Every path is guarded: this file must never raise
while the dashboard is mounting routes.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("aura.dashboard")

router = APIRouter()

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# locating the live server module (same object the agent process imported)
# ---------------------------------------------------------------------------

def _server_module():
    """Return the server module, preferring the already-imported instance."""
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        if name == "aura_core.server" or name.endswith(".aura_core.server"):
            return module
    for loader in (
        lambda: __import__("aura_core.server", fromlist=["server"]),
        lambda: __import__("aura.aura_core.server", fromlist=["server"]),
    ):
        try:
            return loader()
        except Exception:  # noqa: BLE001
            continue
    try:
        if str(_PLUGIN_ROOT) not in sys.path:
            sys.path.insert(0, str(_PLUGIN_ROOT))
        import aura_core.server as module  # noqa: F811
        return module
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: server module unavailable (%s)", type(exc).__name__)
        return None


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path("~/.hermes").expanduser()


def _file_token() -> str:
    try:
        return (_hermes_home() / "aura" / "token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _enabled() -> bool:
    try:
        raw = json.loads((_hermes_home() / "aura" / "config.json").read_text(encoding="utf-8"))
        return bool(raw.get("enabled"))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def _live():
    """``(server_module, port, token)`` with port/token possibly None."""
    server = _server_module()
    if server is None:
        return None, None, _file_token()
    port = None
    token = None
    try:
        port = server.get_port()
    except Exception:  # noqa: BLE001
        port = None
    if port is None:
        try:
            server.ensure_server()  # idempotent; same in-process singleton
            port = server.get_port()
        except Exception:  # noqa: BLE001
            port = None
    try:
        token = server.get_token()
    except Exception:  # noqa: BLE001
        token = None
    return server, port, token or _file_token()


# ---------------------------------------------------------------------------
# payload builders / forwarders (also callable from tests without FastAPI)
# ---------------------------------------------------------------------------

def status_payload() -> dict:
    """The §5 GET /status body."""
    try:
        server, port, token = _live()
        capture = "none"
        if server is not None:
            try:
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '1230,1373p' desktop/plugin.js
if (disposed || mine !== instanceSeq) return
      disposed = true
      teardown()
    }
    disposed = false
    // A hot reload must not inherit a stale backdrop from the previous instance.
    removeBackdrop()
    ctxRef = ctx
    polling = false
    pollDisposer = null
    liveFrame = null
    liveKey = ''
    overrideActive = false
    lastAccentHex = null
    lastAccentAt = 0
    prevTheme = null
    themeInfo = { name: '', accent: '' }
    knownTheme = ''
    disposers.length = 0
    $themeApplied.set(false)
    const settings = readSettings(ctx)
    $settings.set(settings)
    $live.set({ ...EMPTY_LIVE })

    const track = disposer => {
      if (typeof disposer === 'function') disposers.push(disposer)
    }

    track(
      ctx.register({
        id: 'stage',
        area: ROUTES_AREA,
        title: 'Aura',
        data: { path: ROUTE },
        render: () => jsx(Stage, {})
      })
    )

    track(
      ctx.register({
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Aura', codicon: 'pulse' }
      })
    )

    track(
      ctx.register({
        id: 'open-stage',
        area: PALETTE_AREA,
        data: {
          id: 'aura.open',
          label: 'Aura: Open stage',
          keywords: ['aura', 'visualizer', 'milkdrop', 'music', 'stage', 'audio'],
          run: () => {
            try {
              host.navigate(ROUTE)
            } catch {
              // ignore
            }
          }
        }
      })
    )

    track(
      ctx.register({
        id: 'pane',
        area: PANES_AREA,
        title: 'Aura',
        data: {
          placement: 'right',
          dock: { pane: 'workspace', pos: 'right' },
          width: '320px',
          minWidth: '240px'
        },
        render: () => jsx(Stage, { compact: true })
      })
    )

    // An invisible, permanently mounted probe: titlebar slots stay mounted
    // across navigation, so this is where the active theme is read (useTheme
    // is a hook) without reaching into app markup.
    track(
      ctx.register({
        id: 'theme-probe',
        area: TITLEBAR_AREAS.center,
        render: () => jsx(ThemeProbe, {})
      })
    )

    track(
      ctx.register({
        id: THEME_NAME,
        area: THEMES_AREA,
        data: AURA_THEME
      })
    )

    // Settings ▸ Plugins. Older hosts without registerSettingsPage get the
    // same page as a plain SETTINGS_PLUGINS_AREA contribution.
    if (typeof ctx.registerSettingsPage === 'function') {
      track(
        ctx.registerSettingsPage({
          id: 'settings',
          title: 'Aura',
          icon: 'pulse',
          render: () => jsx(AuraSettings, {})
        })
      )
    } else {
      track(
        ctx.register({
          id: 'settings',
          area: SETTINGS_PLUGINS_AREA,
          title: 'Aura',
          data: { children: [], icon: 'pulse' },
          render: () => jsx(AuraSettings, {})
        })
      )
    }

    // Polling is the only timer; the host owns it, so it cannot outlive the
    // plugin even if the returned disposer is never called.
    pollDisposer = ctx.setInterval(() => {
      void poll()
    }, POLL_MS)

    if (doc) {
      track(
        ctx.addEventListener(doc, 'visibilitychange', () => {
          if (!doc.hidden) void poll()
        })
      )
    }

    if (typeof ctx.onDispose === 'function') ctx.onDispose(dispose)

    void poll()
    if (settings.themeOptIn) applyThemeIfOptedIn()

    return dispose
  }
}
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '640,760p' desktop/plugin.js && echo "===restore/enable===" && grep -n "enabled\|enable\|disable\|restore\|teardown\|dispose" desktop/plugin.js | head -50
const opacity = clamp01(next)
  writeSettings({ opacity })
  await pushControl({ opacity })
}

async function setGlass(next) {
  if (!ctxRef || disposed) return
  writeSettings({ glass: clampGlass(next) })
  syncBackdrop()
}

async function setMotion(next) {
  if (!ctxRef || disposed) return
  const motion = MOTIONS.includes(next) ? next : 'both'
  writeSettings({ motion })
  await pushControl({ motion })
}

async function setBehavior(next) {
  if (!ctxRef || disposed) return
  const behavior = BEHAVIORS.includes(next) ? next : 'balanced'
  writeSettings({ behavior })
  await pushControl({ behavior })
}

async function setMoodReactive(next) {
  if (!ctxRef || disposed) return
  const moodReactive = Boolean(next)
  writeSettings({ moodReactive })
  if (!moodReactive) {
    // No stale mood-derived accent survives the switch-off.
    clearAccent(true)
  }
  await pushControl({ mood_reactive: moodReactive })
  if (moodReactive) void poll()
}

async function setAccentPulse(next) {
  if (!ctxRef || disposed) return
  const accentPulse = Boolean(next)
  writeSettings({ accentPulse })
  if (!accentPulse) {
    // HARD RULE: the accent pulse must stop through setAccentOverride(null).
    clearAccent(true)
  } else {
    accentStep(Date.now())
  }
  await pushControl({ accent_pulse: accentPulse })
}

async function setAutoPreset(next) {
  if (!ctxRef || disposed) return
  const autoPreset = Boolean(next)
  writeSettings({ autoPreset })
  await pushControl({ auto_preset: autoPreset })
}

// ---------------------------------------------------------------------- UI

function ThemeProbe() {
  const active = useTheme()
  const name = active && typeof active.themeName === 'string' ? active.themeName : ''
  const accent = accentOf(active && active.theme)
  if (name) themeInfo.name = name
  if (accent) themeInfo.accent = accent
  useEffect(() => {
    onThemeName(name)
  }, [name])
  return null
}

function StageFrame({ url }) {
  return jsx('iframe', {
    src: url,
    title: 'Aura visualizer',
    // Same-origin is required: the page talks to its own 127.0.0.1 origin
    // (WebSocket token + fetch) and the server sends no CORS headers.
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads',
    referrerPolicy: 'no-referrer',
    allow: 'autoplay; fullscreen',
    allowFullScreen: true,
    style: {
      flex: 1,
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
      border: 0,
      display: 'block',
      background: 'var(--ui-bg)'
    }
  })
}

function StageMessage({ live, onRetry, busy }) {
  const reason = live.error || (live.ok ? 'Aura is warming up…' : 'Aura’s local server is not running.')
  return jsxs('div', {
    style: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: 24,
      textAlign: 'center'
    },
    children: [
      jsx('div', {
        key: 'title',
        style: { fontSize: 13, color: 'var(--ui-text-primary)' },
        children: 'The Aura stage is not available yet.'
      }),
      jsx('div', {
        key: 'reason',
        style: { fontSize: 12, color: 'var(--ui-text-secondary)', maxWidth: 420 },
        children: reason
      }),
      jsx('div', {
        key: 'hint',
===restore/enable===
17: *   - a settings page (`SETTINGS_PLUGINS_AREA`) with enable / reaction strength /
28: * react/jsx-runtime. Every contribution and timer returns a disposer, and
29: * `register()` returns one disposer that stops polling, clears the accent
30: * override, restores the user's previous theme and removes every contribution.
59:// poll of /status (plus /state only while Aura is enabled), and the accent is
69:  enabled: true,
93:  enabled: false,
187:let disposed = false
201:const disposers = []
218:    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
390:  // The server's enabled flag is the truth (the pane uses it too); the local
392:  const enabled = live.ok ? live.enabled === true : settings.enabled
393:  const wanted = Boolean(doc && enabled && knownTheme === THEME_NAME && url)
438:  if (!ctxRef || disposed) return false
449:  if (!ctxRef || disposed || polling) return
472:    const enabled = ok ? status.enabled === true : $settings.get().enabled
489:    const key = [ok, port, capture, enabled, url, error, mood].join('|')
497:        enabled,
549:  if (disposed) return
552:  if (!live.ok || !live.enabled || !settings.accentPulse || settings.intensity <= 0) {
582:  if (disposed || !ctxRef || $themeApplied.get()) return Boolean($themeApplied.get())
591:function restoreTheme() {
615:  else restoreTheme()
618:// ------------------------------------------------------------- enable switch
621:  if (!ctxRef || disposed) return
622:  const enabled = Boolean(next)
623:  writeSettings({ enabled })
624:  if (!enabled) {
626:    restoreTheme()
631:  const ok = await pushControl({ enabled })
633:    setLive({ enabled, error: '' })
639:  if (!ctxRef || disposed) return
646:  if (!ctxRef || disposed) return
652:  if (!ctxRef || disposed) return
659:  if (!ctxRef || disposed) return
666:  if (!ctxRef || disposed) return
678:  if (!ctxRef || disposed) return
691:  if (!ctxRef || disposed) return
769:        disabled: busy,
823:  const state = live.ok ? (live.enabled ? 'on' : 'off') : 'offline'
846:          jsx(StatusDot, { key: 'dot', tone: live.ok ? (live.enabled ? 'good' : 'muted') : 'warn' }),
913:        key: 'enabled',
915:          'Aura enabled',
918:            checked: settings.enabled,
919:            'aria-label': 'Aura enabled',
937:            disabled: settings.motion === 'designs',
1114:            ? 'Aura Live is active. Turning this off restores the theme you had before.'
1115:            : 'Optional deep-stage palette. Your current theme is restored when you turn it off.',
1182:// --------------------------------------------------------------- teardown
1185: *  the OLD disposer must not tear down the new one. */
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "WebGL\|webgl\|fallback\|unsupported\|no audio\|not available\|silence" web/aura.js | head -40
12: *   - no audio output: every path to ctx.destination goes through gain 0;
16: *   - failure is always visible: one-line message + accent-only fallback, never a
28:  const FORCE_NO_WEBGL = params.get('no-webgl') === '1';
41:  const HARD_BLOCKERS = ['token', 'webgl', 'capture', 'audio', 'perf'];
151:  let silenceTimer = null;
161:  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
290:    const fallback = !!hard;
291:    if (dom.root) dom.root.dataset.fallback = fallback ? '1' : '0';
293:      dom.canvas.style.visibility = fallback ? 'hidden' : 'visible';
303:    if (fallback) {
569:        // Accent-only fallback needs to carry the room on its own; when the
717:    // fallback: any allowed preset of a matching family (first choice)
737:  function detectWebGL() {
738:    if (FORCE_NO_WEBGL) return { ok: false, renderer: 'disabled by ?no-webgl=1', software: true };
743:      gl = probe.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
759:    const webgl = detectWebGL();
760:    quality.renderer = webgl.renderer;
761:    quality.software = webgl.software;
762:    quality.tier = webgl.ok ? (webgl.software ? 'degraded-software' : 'full') : 'none';
764:    quality.renderScale = webgl.software ? 0.45 : 1;
765:    quality.fpsCap = webgl.software ? 24 : 60;
770:    return webgl;
969:    if (hardBlocker() === 'webgl' || hardBlocker() === 'token' || hardBlocker() === 'capture') return false;
971:    const webgl = applyQualityTier();
972:    if (!webgl.ok) {
973:      block('webgl', 'WebGL 2 is unavailable here — showing the accent-only fallback.');
978:      block('webgl', 'The visualizer library failed to load — showing the accent-only fallback.');
993:      block('webgl', 'The visualizer could not start on this GPU — showing the accent-only fallback.');
999:    if (!silenceTimer) silenceTimer = setInterval(tickSilence, 250);
1039:        block('perf', 'Rendering is too slow on this GPU — showing the accent-only fallback.');
1055:    if (state.renderPaused) return; // silence gate: nothing to draw
1063:      block('webgl', 'The visualizer stopped — showing the accent-only fallback.');
1074:      try { gl = dom.canvas.getContext('webgl2'); } catch (_) {}
1094:  // silence gate
1099:  // curated presets stayed lit at mean 24..155 in silence). The visual is
1100:  // supposed to follow the audio, so sustained silence fades the canvas out and
1108:    try { gl = dom.canvas.getContext('webgl2'); } catch (_) { gl = null; }
1124:    if (dom.root) dom.root.dataset.silence = '1';
1131:    if (dom.root) dom.root.dataset.silence = '0';
1136:  // Called for every PCM frame and every feature event: silence=true means the
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && cat docs/PUBLISH.md | head -120 && echo "===last test===" && cat .last-test.log
# Publishing Aura — drafts to approve

Nothing here has been executed. Every step below is a public action and needs an explicit
"go" from Daniel first (standing rule: ask before any public commit/PR/repo/post/form).

## 0. Preconditions

- Repo `/mnt/homes/Development/hermes-aura` is **local-only** (no remote configured). Check:
  `git remote -v` (currently empty).
- The catalog requires a **public** repo and an **exact 40-char SHA** pin, submitted by the
  repository owner or a major contributor.
- `hermes plugins validate .` passes (desktop-surface + security scan included).
- Platform honesty: Linux verified; Windows and macOS implemented but **not** verified — the
  catalog description and README must say so.

## 1. Create and push the repo (needs OK)

Suggested name: `hermes-aura` under the user's account. Description:

> Audio-reactive visualizer and living theme for Hermes Desktop: it listens to whatever your
> computer is playing (system loopback, never the microphone), draws a MilkDrop-compatible
> stage, pulses the app accent with the music, and reacts to what the agent is doing. Local
> only — no account, no network, no audio recorded.

Topics: `hermes-plugin`, `visualizer`, `butterchurn`, `milkdrop`, `audio-reactive`, `pipewire`.

Before pushing: rotate nothing (no secrets in the tree — verified: token lives in
`$HERMES_HOME/aura/token` at runtime and is never committed), and confirm `.gitignore` covers
`.demo/`, `.last-test.log`, `.venv/`, `*.pyc`.

## 2. Catalog entry (draft YAML — pin the SHA only after the push)

Path in the hermes-agent repo: `plugin-catalog/aura.yaml`

```yaml
name: aura
repo: https://github.com/<owner>/hermes-aura
sha: <40-char commit SHA from the pushed default branch>
description: >-
  Audio-reactive visualizer and living theme for Hermes Desktop. It captures system audio
  loopback (what the machine is already playing — never the microphone), streams it locally
  to an Aura stage that renders a MilkDrop-compatible visualization, pulses the app accent
  colour with the music, and shifts mood with what the agent is doing (thinking, tools,
  approval, error, streaming, done). Display controls: opacity, calm/balanced/intense
  behaviour profiles (calm is reduced-motion safe and never uses strobe presets), and
  switches for agent-mood reactions, accent pulse and automatic preset rotation. Starts off,
  never plays or ducks sound, and does everything on the machine: no account, no network,
  nothing recorded. Linux verified; Windows (WASAPI loopback) and macOS (virtual audio
  device) are implemented but unverified.
maintainer: <owner>
tier: community
category: appearance
docs_url: https://github.com/<owner>/hermes-aura#readme
version: "0.1.1"
platforms: [linux, windows, macos]
capabilities:
  provides_tools: [aura_control]
  provides_hooks:
    - on_session_start
    - on_session_end
    - pre_tool_call
    - post_tool_call
    - pre_approval_request
    - post_approval_response
    - api_request_error
    - on_stream_start
    - on_stream_end
    - subagent_start
    - subagent_stop
  provides_middleware: []
  requires_env: []
```

## 3. PR title and body (draft)

Title: `catalog: add aura — audio-reactive visualizer and living theme`

Body:

```
Adds `aura` to the catalog.

What it does: captures system audio loopback (PipeWire/Pulse on Linux, WASAPI on Windows,
virtual device on macOS) and renders it as a MilkDrop-compatible visualizer in a full-window
stage, pulses the app accent colour with the music, and reacts to agent state. It never plays,
pauses or ducks audio; capture is loopback only, never the microphone; all analysis is local.

Safety posture:
- Turn Aura off using the stage control or Aura settings.
- Random ephemeral port on 127.0.0.1 with a per-process token file (0600). Static assets are
  public (a browser cannot attach a bearer to <script src>); every data endpoint and the
  WebSocket require the token. Host-header guard against DNS rebinding.
- No network egress of any kind; nothing recorded to disk.
- Desktop half stays inside the plugin SDK surface; `hermes plugins validate` passes including
  the security scan and the desktop-surface check.
- Reduced-motion: a dedicated `calm` profile with no strobe presets and no hard pulses.

Verified: 178 tests (unit + real-Chrome e2e + integration), measured on Linux. Windows (WASAPI)
and macOS capture are implemented but **unverified** — flagged in the description.

No self-updater; the SHA pin is the update mechanism.
```

## 4. Submission blurb (hackathon form / README summary)

> Aura turns Hermes Desktop into a room that reacts to your music and to what the agent is
> doing. It listens to whatever the machine is already playing — no account, no integration,
> no audio leaving the box — and draws it: a full-window MilkDrop stage, an accent colour that
> breathes with the beat, and a mood that shifts when the agent thinks, runs a tool, waits for
> approval or finishes. Opacity, behaviour and reaction switches are yours to set; it starts
> off, and it never makes or ducks a sound.

## 5. X post (draft, 280 chars)

> Built Aura for @NousResearch Hermes: it listens to whatever your machine is playing (loopback,
> never the mic), draws a MilkDrop stage, pulses the app accent with the beat, and shifts mood
> when the agent thinks or waits for approval. Local only, starts off, version 0.1.1.

## 6. Approval checklist

===last test===
........................................................................ [ 40%]
........................................................................ [ 80%]
..................................                                       [100%]
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "enabled" aura_core/config.py aura_core/server.py __init__.py desktop/plugin.js | head -40
aura_core/config.py:27:    "enabled": False,
aura_core/config.py:149:    cfg["enabled"] = _as_bool(raw.get("enabled"), DEFAULTS["enabled"])
aura_core/server.py:292:        "enabled": bool(cfg["enabled"]),
aura_core/server.py:662:                "enabled": bool(cfg["enabled"]),
aura_core/server.py:682:            "enabled": bool(cfg["enabled"]),
aura_core/server.py:899:    if "enabled" in data:
aura_core/server.py:900:        if not isinstance(data["enabled"], bool):
aura_core/server.py:901:            raise ValueError("enabled_must_be_bool")
aura_core/server.py:902:        applied["enabled"] = data["enabled"]
aura_core/server.py:958:             if k in ("enabled", "intensity", "preset", "opacity", "behavior",
aura_core/server.py:975:    if applied.get("enabled") is False:
__init__.py:18:* Config ``enabled: false`` is a kill switch: every hook becomes a no-op and
__init__.py:68:    enabled = True
__init__.py:94:        if _CFG.enabled:
__init__.py:222:def _set_enabled(flag: bool) -> None:
__init__.py:224:    _CFG.enabled = bool(flag)
__init__.py:229:def _persist_enabled(flag: bool) -> None:
__init__.py:237:        set_config("enabled", bool(flag))
__init__.py:250:            if not _CFG.enabled or _MACHINE is None:
__init__.py:360:            "enabled": _CFG.enabled,
__init__.py:372:        "enabled": _CFG.enabled,
__init__.py:386:        payload["enabled"] = bool(live.get("enabled", payload["enabled"]))
__init__.py:401:    _set_enabled(flag)
__init__.py:402:    _persist_enabled(flag)
__init__.py:410:        applied = _control({"enabled": bool(flag)})
__init__.py:416:    payload["enabled"] = bool(flag)
__init__.py:566:        enabled = ctx.get_config("enabled", True)
__init__.py:567:        _CFG.enabled = bool(enabled)
__init__.py:569:        _CFG.enabled = True
__init__.py:580:    if not _CFG.enabled and _MACHINE is not None:
desktop/plugin.js:59:// poll of /status (plus /state only while Aura is enabled), and the accent is
desktop/plugin.js:69:  enabled: true,
desktop/plugin.js:93:  enabled: false,
desktop/plugin.js:218:    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
desktop/plugin.js:390:  // The server's enabled flag is the truth (the pane uses it too); the local
desktop/plugin.js:392:  const enabled = live.ok ? live.enabled === true : settings.enabled
desktop/plugin.js:393:  const wanted = Boolean(doc && enabled && knownTheme === THEME_NAME && url)
desktop/plugin.js:472:    const enabled = ok ? status.enabled === true : $settings.get().enabled
desktop/plugin.js:489:    const key = [ok, port, capture, enabled, url, error, mood].join('|')
desktop/plugin.js:497:        enabled,
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '1,90p' aura_core/config.py
"""Aura configuration: the JSON file under the Hermes home directory.

Layout (all paths derive from ``HERMES_HOME``, default ``~/.hermes``)::

    <HERMES_HOME>/aura/config.json    0600, atomic replace
    <HERMES_HOME>/aura/token          0600, written by the server on start

Everything here is tolerant: a corrupt or missing file yields the defaults, a
wrong-typed field is coerced or ignored, and no function raises on bad input.
Stdlib only; no third-party imports at runtime.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger("aura.config")

CONFIG_VERSION = 1

DEFAULTS = {
    "enabled": False,
    "intensity": 0.5,
    "preset": None,
    "reduced_motion": False,
    # Kept for /api/config (§1) even though the task text lists four fields.
    "theme_opt_in": False,
    # Display controls (CONTRACT.md §9). Opacity dims the canvas and its scrim
    # together; behavior is a named profile with concrete render parameters.
    "opacity": 0.75,
    "behavior": "calm",
    "mood_reactive": True,
    "accent_pulse": True,
    "auto_preset": True,
    # Motion source for the visualizer: ambient designs, real audio, or both.
    "motion": "both",
}

BEHAVIORS = ("calm", "balanced", "intense")
MOTIONS = ("designs", "both", "music")

_lock = threading.RLock()


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

def hermes_home() -> Path:
    """The Hermes home directory, honouring ``HERMES_HOME`` at call time."""
    raw = os.environ.get("HERMES_HOME")
    if raw:
        try:
            return Path(raw).expanduser()
        except (TypeError, ValueError):
            pass
    return Path("~/.hermes").expanduser()


def aura_dir() -> Path:
    return hermes_home() / "aura"


def config_path() -> Path:
    return aura_dir() / "config.json"


def token_path() -> Path:
    return aura_dir() / "token"


def _ensure_dir() -> Path:
    d = aura_dir()
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


# ---------------------------------------------------------------------------
# validation / coercion
# ---------------------------------------------------------------------------
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -n "def ensure_server\|def _start\|capture\|enabled" aura_core/server.py | head -60
14:* Capture runs in a daemon thread. No device means ``capture == "none"`` and
41:from .capture import base as capture
134:        self.capture_obj: Any = None
135:        self.capture_thread: threading.Thread | None = None
136:        self.capture_name = "none"
150:        self.capture_lost_reported = False
292:        "enabled": bool(cfg["enabled"]),
295:        "capture": _STATE.capture_name,
348:# capture / feature pump
351:def _capture_loop(stop_event: threading.Event) -> None:
356:        preferred = config.capture_override()
359:        cap = capture.open_capture(preferred)
361:            _STATE.capture_obj = cap
362:            _STATE.capture_name = cap.name
363:        _log("aura: capture backend %s", cap.name)
364:    except Exception as exc:  # noqa: BLE001 - capture must never break serving
365:        _log("aura: capture open failed (%s); using silence", type(exc).__name__)
366:        cap = capture.NullCapture()
368:            _STATE.capture_obj = cap
369:            _STATE.capture_name = "none"
383:                    retry = capture.open_capture(preferred)
389:                        _STATE.capture_obj = cap
390:                        _STATE.capture_name = cap.name
391:                    _log("aura: capture backend %s (after retry)", cap.name)
398:                _log("aura: capture read failed (%s)", type(exc).__name__)
401:                if cap.name != "none" and not _STATE.capture_lost_reported:
403:                        _STATE.capture_lost_reported = True
404:                        _broadcast_event({"type": "error", "code": "capture_lost",
405:                                          "message": "audio capture stopped; visualizer is idle"})
409:                _STATE.capture_lost_reported = False
413:                if stop_event.wait(FRAME_SAMPLES / capture.SAMPLE_RATE):
454:            _STATE.capture_obj = None
643:                "capture": _STATE.capture_name,
662:                "enabled": bool(cfg["enabled"]),
680:            "capture": _STATE.capture_name,
682:            "enabled": bool(cfg["enabled"]),
899:    if "enabled" in data:
900:        if not isinstance(data["enabled"], bool):
901:            raise ValueError("enabled_must_be_bool")
902:        applied["enabled"] = data["enabled"]
958:             if k in ("enabled", "intensity", "preset", "opacity", "behavior",
975:    if applied.get("enabled") is False:
1001:def _start_server() -> None:
1002:    """Create the socket, bind, and start serving + capture in daemon threads."""
1022:        _STATE.capture_name = "none"
1026:        _STATE.capture_lost_reported = False
1029:    cap_thread = threading.Thread(target=_capture_loop, args=(stop_event,),
1030:                                  name="aura-capture", daemon=True)
1032:        _STATE.capture_thread = cap_thread
1044:def ensure_server() -> None:
1078:def get_capture() -> str:
1081:            return _STATE.capture_name
1142:            cap_thread = _STATE.capture_thread
1148:            _STATE.capture_thread = None
1169:            _STATE.capture_name = "none"
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '250,340p' aura_core/server.py && sed -n '940,1010p' aura_core/server.py
return 0x1, self.events.popleft()
            return None

    def send(self, opcode: int, payload: bytes) -> None:
        with self._send_lock:
            self.sock.sendall(_ws_frame(opcode, payload))

    def close(self) -> None:
        with self.cond:
            if self.closed:
                return
            self.closed = True
            self.cond.notify_all()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# broadcast / events
# ---------------------------------------------------------------------------

def _clients_snapshot() -> list:
    with _STATE.lock:
        return list(_STATE.clients)


def _broadcast_pcm(payload: bytes) -> None:
    for client in _clients_snapshot():
        client.push_pcm(payload)


def _broadcast_event(obj: dict) -> None:
    for client in _clients_snapshot():
        client.push_event(obj)


def _config_event() -> dict:
    cfg = config.load_config()
    return {
        "type": "config",
        "enabled": bool(cfg["enabled"]),
        "intensity": cfg["intensity"],
        "reduced_motion": cfg["reduced_motion"],
        "capture": _STATE.capture_name,
        "theme_opt_in": cfg["theme_opt_in"],
        "opacity": cfg["opacity"],
        "behavior": cfg["behavior"],
        "mood_reactive": bool(cfg["mood_reactive"]),
        "accent_pulse": bool(cfg["accent_pulse"]),
        "auto_preset": bool(cfg["auto_preset"]),
        "motion": cfg["motion"],
        "behavior_profile": behavior.profile(cfg["behavior"]),
    }


def _mood_event(mood: str, intensity: float, ttl_ms: int) -> dict:
    with _STATE.lock:
        _STATE.feature_seq += 1
        seq = _STATE.feature_seq
    return {
        "type": "mood",
        "mood": mood,
        "intensity": max(0.0, min(1.0, float(intensity))),
        "ttl_ms": max(0, int(ttl_ms)),
        "seq": seq,
    }


def _mood_tick(now: float) -> None:
    """Expire a timed mood back to the previous one; keepalive non-idle moods."""
    with _STATE.lock:
        mood = _STATE.mood
        expiry = _STATE.mood_expiry
        intensity = _STATE.mood_intensity
        ttl = _STATE.mood_ttl_ms
        send = False
        if expiry is not None and now >= expiry:
            _STATE.mood = _STATE.mood_prev
            _STATE.mood_intensity = _STATE.mood_prev_intensity
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
            mood = _STATE.mood
            intensity = _STATE.mood_intensity
            ttl = 0
            send = True
        elif mood != "idle" and now - _STATE.mood_last_sent >= MOOD_KEEPALIVE_S:
            send = True
        else:
            send = False
        value = data["motion"]
        if not isinstance(value, str):
            raise ValueError("motion_must_be_string")
        value = value.strip().lower()
        if value not in config.MOTIONS:
            raise ValueError("bad_motion")
        applied["motion"] = value
    for toggle in ("mood_reactive", "accent_pulse", "auto_preset"):
        if toggle in data:
            if not isinstance(data[toggle], bool):
                raise ValueError(toggle + "_must_be_bool")
            applied[toggle] = data[toggle]
    return applied


def _apply_control(data) -> dict:
    applied = _validate_control(data)
    patch = {k: v for k, v in applied.items()
             if k in ("enabled", "intensity", "preset", "opacity", "behavior",
                      "mood_reactive", "accent_pulse", "auto_preset", "motion")}
    if patch:
        cfg = config.merge_config(patch)
        if "preset" in applied:
            with _STATE.lock:
                _STATE.preset = cfg["preset"]
        _broadcast_event(_config_event())
    if applied.get("mood_reactive") is False:
        # The agent-mood layer is off: no leftover mood, no latched pulse.
        with _STATE.lock:
            _STATE.mood = "idle"
            _STATE.mood_intensity = 0.0
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
    if "mood" in applied:
        publish_mood(applied["mood"], 1.0, 0)
    if applied.get("enabled") is False:
        # §4: disabling Aura clears mood state; re-enable starts at idle.
        with _STATE.lock:
            _STATE.mood = "idle"
            _STATE.mood_intensity = 0.0
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
    return applied


# ---------------------------------------------------------------------------
# server lifecycle
# ---------------------------------------------------------------------------

class _Httpd(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):  # noqa: N802
        try:
            exc = getattr(self, "_last_exc", None)
            logger.debug("aura: connection error (%s)", type(exc).__name__ if exc else "?")
        except Exception:  # noqa: BLE001
            pass


def _start_server() -> None:
    """Create the socket, bind, and start serving + capture in daemon threads."""
    token = secrets.token_urlsafe(32)
    try:
        config.write_token(token)
    except OSError as exc:
        _log("aura: token file write failed (%s)", type(exc).__name__)

    httpd = _Httpd(("127.0.0.1", 0), _Handler)
    port = int(httpd.server_address[1])
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '348,460p' aura_core/server.py && echo "===start===" && sed -n '1001,1070p' aura_core/server.py
# capture / feature pump
# ---------------------------------------------------------------------------

def _capture_loop(stop_event: threading.Event) -> None:
    analyser = analysis.Analyser()
    cap = None
    preferred = None
    try:
        preferred = config.capture_override()
        if preferred and preferred not in ("pipewire", "pulse", "wasapi", "macos", "none"):
            preferred = None
        cap = capture.open_capture(preferred)
        with _STATE.lock:
            _STATE.capture_obj = cap
            _STATE.capture_name = cap.name
        _log("aura: capture backend %s", cap.name)
    except Exception as exc:  # noqa: BLE001 - capture must never break serving
        _log("aura: capture open failed (%s); using silence", type(exc).__name__)
        cap = capture.NullCapture()
        with _STATE.lock:
            _STATE.capture_obj = cap
            _STATE.capture_name = "none"

    last_feature = 0.0
    last_data = time.monotonic()
    last_probe = last_data
    try:
        while not stop_event.is_set():
            now = time.monotonic()
            if (cap.name == "none" and preferred != "none"
                    and now - last_probe >= CAPTURE_RETRY_S):
                # The first probe can miss audio (busy host at startup, sound
                # server or device not ready yet); never lock in silence.
                last_probe = now
                try:
                    retry = capture.open_capture(preferred)
                except Exception:  # noqa: BLE001
                    retry = None
                if retry is not None and retry.name != "none":
                    cap = retry
                    with _STATE.lock:
                        _STATE.capture_obj = cap
                        _STATE.capture_name = cap.name
                    _log("aura: capture backend %s (after retry)", cap.name)
                    publish_config()  # open pages still show "no system audio"
                now = time.monotonic()
            frame = None
            try:
                frame = cap.read(FRAME_SAMPLES)
            except Exception as exc:  # noqa: BLE001
                _log("aura: capture read failed (%s)", type(exc).__name__)
                frame = None
            if frame is None:
                if cap.name != "none" and not _STATE.capture_lost_reported:
                    if now - last_data > 2.0:
                        _STATE.capture_lost_reported = True
                        _broadcast_event({"type": "error", "code": "capture_lost",
                                          "message": "audio capture stopped; visualizer is idle"})
                frame = b"\x00" * (FRAME_SAMPLES * 4)
            else:
                last_data = now
                _STATE.capture_lost_reported = False
            if cap.name == "none":
                # NullCapture returns silence instantly; pace it to real time or
                # this thread spins a full core and starves the host's GIL.
                if stop_event.wait(FRAME_SAMPLES / capture.SAMPLE_RATE):
                    break

            ts_ms = int(now * 1000)
            with _STATE.lock:
                _STATE.pcm_seq += 1
                seq = _STATE.pcm_seq
                silence = bool(_STATE.features.get("silence"))
            if _clients_snapshot():
                _broadcast_pcm(_ws_pcm_frame(seq, ts_ms, frame, silence))

            if now - last_feature >= FEATURE_INTERVAL_S:
                last_feature = now
                if cap.name == "none":
                    feat = analysis.silence_features()
                else:
                    feat = analyser.analyse(frame, ts_ms=ts_ms)
                with _STATE.lock:
                    _STATE.feature_seq += 1
                    fseq = _STATE.feature_seq
                    _STATE.features = feat
                event = {
                    "type": "features",
                    "seq": fseq,
                    "ts_ms": ts_ms,
                    "level": round(float(feat["level"]), 4),
                    "bands": [round(float(b), 4) for b in feat["bands"]],
                    "onset": bool(feat["onset"]),
                    "centroid": round(float(feat["centroid"]), 4),
                    "flatness": round(float(feat["flatness"]), 4),
                    "silence": bool(feat["silence"]),
                }
                _broadcast_event(event)

            _mood_tick(now)
    finally:
        try:
            cap.close()
        except Exception:  # noqa: BLE001
            pass
        with _STATE.lock:
            _STATE.capture_obj = None


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

===start===
def _start_server() -> None:
    """Create the socket, bind, and start serving + capture in daemon threads."""
    token = secrets.token_urlsafe(32)
    try:
        config.write_token(token)
    except OSError as exc:
        _log("aura: token file write failed (%s)", type(exc).__name__)

    httpd = _Httpd(("127.0.0.1", 0), _Handler)
    port = int(httpd.server_address[1])

    stop_event = threading.Event()
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1},
                              name="aura-http", daemon=True)

    with _STATE.lock:
        _STATE.token = token
        _STATE.httpd = httpd
        _STATE.port = port
        _STATE.stop_event = stop_event
        _STATE.thread = thread
        _STATE.capture_name = "none"
        _STATE.features = analysis.silence_features()
        _STATE.feature_seq = 0
        _STATE.pcm_seq = 0
        _STATE.capture_lost_reported = False

    thread.start()
    cap_thread = threading.Thread(target=_capture_loop, args=(stop_event,),
                                  name="aura-capture", daemon=True)
    with _STATE.lock:
        _STATE.capture_thread = cap_thread
    cap_thread.start()
    _log("aura: listening on 127.0.0.1:%d", port)


# ---------------------------------------------------------------------------
# public internal API (CONTRACT §7) — all swallow-and-log
# ---------------------------------------------------------------------------

_START_LOCK = threading.Lock()


def ensure_server() -> None:
    """Start the server in a daemon thread if it is not running. Idempotent."""
    try:
        with _START_LOCK:
            with _STATE.lock:
                running = (_STATE.httpd is not None and _STATE.thread is not None
                           and _STATE.thread.is_alive())
            if running:
                return
            _start_server()
    except Exception as exc:  # noqa: BLE001 - never block register()/a hook
        _log("aura: server start failed (%s)", type(exc).__name__)


def get_port() -> int | None:
    """Live port, or ``None`` when the server has not started."""
    try:
        with _STATE.lock:
            if _STATE.httpd is None:
                return None
            return _STATE.port
    except Exception:  # noqa: BLE001
        return None


def get_token() -> str | None:
    """The in-process token (for the port-discovery door). Never log it raw."""
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && sed -n '80,100p' __init__.py && grep -n "def _boot" -A20 __init__.py
def _ensure() -> None:
    if _server is None:
        return
    ensure_server = getattr(_server, "ensure_server", None)
    if ensure_server is None:
        return
    ensure_server()


def _boot() -> None:
    # Background start at load time.  A host that forbids sockets (Plugin
    # Doctor, sandboxes) must not print a traceback; the first tool call retries.
    try:
        if _CFG.enabled:
            _ensure()
    except Exception as exc:  # noqa: BLE001
        logger.info("aura: server not started at load (%s); will retry on first use", exc)


def _port() -> int | None:
90:def _boot() -> None:
91-    # Background start at load time.  A host that forbids sockets (Plugin
92-    # Doctor, sandboxes) must not print a traceback; the first tool call retries.
93-    try:
94-        if _CFG.enabled:
95-            _ensure()
96-    except Exception as exc:  # noqa: BLE001
97-        logger.info("aura: server not started at load (%s); will retry on first use", exc)
98-
99-
100-def _port() -> int | None:
101-    if _server is None:
102-        return None
103-    get_port = getattr(_server, "get_port", None)
104-    if get_port is None:
105-        return None
106-    try:
107-        port = get_port()
108-    except Exception:  # noqa: BLE001
109-        return None
110-    if not port:
[0m
[0m$ [0mcd /mnt/homes/Development/hermes-aura && grep -rn "enabled" tests/test_server.py tests/test_behavior.py tests/test_hooks.py | head -30
tests/test_server.py:217:    {"enabled": "yes"},
tests/test_server.py:253:                                body={"enabled": True, "intensity": 0.7,
tests/test_server.py:257:    assert applied == {"ok": True, "applied": {"enabled": True,
tests/test_server.py:263:    assert stored["enabled"] is True
tests/test_server.py:270:    assert state["enabled"] is True
tests/test_server.py:555:    saved = config.save_config({"enabled": True, "intensity": 2.5, "preset": 7})
tests/test_server.py:556:    assert saved["enabled"] is True
tests/test_server.py:560:    assert json.loads(path.read_text(encoding="utf-8"))["enabled"] is True
tests/test_server.py:619:                          body={"enabled": False})
tests/test_server.py:682:def test_config_event_carries_enabled():
tests/test_server.py:685:    assert isinstance(event["enabled"], bool)
tests/test_hooks.py:90:    p._CFG.enabled = True
tests/test_hooks.py:136:    ctx = FakeCtx({"enabled": False})
tests/test_hooks.py:138:    assert p._CFG.enabled is False
tests/test_hooks.py:315:    p._set_enabled(False)
tests/test_hooks.py:325:    p._set_enabled(False)
tests/test_hooks.py:327:    p._set_enabled(True)
[0m
Read the repo. One correction to the brief up front: **"off until you turn it on" is not true in the code.** `__init__.py:566` defaults the hook/config gate to `True`, `_boot` then starts the server, and `aura_core/server.py:351` starts the PipeWire capture loop unconditionally — it never checks `enabled`. Disabling clears mood/visuals but leaves capture running (`server.py:975`). That is a Reliability and trust landmine, not a polish detail.

## 1. Ranked, by score per hour

1. **Make "off" mean off; kill the double capture.** Gate `_capture_loop` on the live `enabled` flag, stop/park the thread on disable, default every layer to off (`__init__.py`, `desktop/plugin.js:69`, config already false), and ensure only one process captures.
   *Why:* Reliability is 25 pts and judges test the privacy claim they're told to test. A loopback capture that ignores the stop button is the one finding that can sink an otherwise good entry. **4–6 h.**

2. **Freeze a submission revision and rehearse install + record the demo on it.** Fresh `HERMES_HOME`, no dev state, exact commit.
   *Why:* Reliability is judged on install, not on your tree; the 60s video is the only artifact most judges experience. One revision, no changes after recording. **6–8 h.**

3. **Make agent mood unmistakable, muted-friendly.** On approval/error: full-preset-family hard cut + large `launchSongTitleAnim` label ("APPROVAL NEEDED", tool name, "ERROR") + accent sweep; verify each mood fires from real hooks inside Hermes.
   *Why:* This is the only genuinely novel feature. It carries Usefulness and Creativity, and it's the memorable moment even with sound off. **5–7 h.**

4. **Polish the surfaces judges touch.** One settings panel, visible "Aura is listening" + one-click stop, readable chat over the backdrop, calm/reduced-motion visibly working, honest failure messages (no audio, no WebGL, server down — the fallbacks exist; verify them on screen).
   *Why:* Polish is the biggest measured gap (17.5/25). **4–6 h.**

5. **Publish now.** Public repo, catalog PR, exact SHA. External review time is not compressible.
   *Why:* An entry that isn't installable scores zero on Reliability. **3 h + waiting.**

## 2. Four-day split (~28 focused hours)

- Reliability / off-switch / single capture: **25%**
- Demo + freeze + clean-install rehearsal: **25%**
- Agent-mood legibility: **25%**
- Polish/fallbacks: **20%**
- Publish/admin: **5%**
- **Studio: 0 h** (see below) — or 2 h only to turn the existing settings page into a panel.

## 3. Cut or don't claim

- **Windows and macOS.** The catalog draft says `platforms: [linux, windows, macos]` — change to `[linux]`. Don't ship unverified code as a claim.
- **"Starts off" / "one click to stop"** until #1 is fixed.
- **Studio P2/P3.** Full MilkDrop control parity is 1.5+ days of new UI judges will almost never open. Keep the settings surface you already have; fold *hard cut on approval* into the mood work.
- **Removing the stage page and side pane.** Two working entry points are a fallback; ripping them out four days out is pure risk.
- Optional audio-following theme palette, `.milk` import, auto preset rotation if it's flaky.
- Say "MilkDrop-compatible", never "MilkDrop".

## 4. 60-second script

0–4s: Hermes open, music playing, Aura Live reacting. Title: "A room that reacts."
4–12s: type a request → backdrop shifts to "thinking" preset; label "thinking".
12–22s: tool runs; then **approval** → whole backdrop hard-cuts, big "APPROVAL NEEDED", accent pulses. Hold 3s, muted.
22–30s: approve → "done" settles to calm.
30–38s: force an error → red tint, "ERROR", then visibly restores to the previous mood.
38–48s: open settings; show calm/reduced-motion; click off → capture stops, theme restores.
48–56s: no-audio and WebGL-disabled fallbacks still look alive.
56–60s: "Linux verified. Local-only, loopback never mic. Nothing recorded." + repo.

## 5. The risk they're not seeing

The off switch doesn't stop audio capture, and capture starts by default — so a judge who installs it, clicks off, and checks `ps`/CPU sees it still listening. That directly contradicts the privacy claim the entry is built on, and it's cheap to fix now.
DONE
