[0m
> build · DeepSeek-V4.1-Flash-1017
[0m
[0m→ [0mRead README.md
[0m→ [0mRead LIMITS.md
[0m
[0m$ [0mls /mnt/homes/Development/hermes-aura
aura_core
CONTRACT.md
dashboard
desktop
docs
__init__.py
LIMITS.md
opencode.json
plugin.yaml
__pycache__
pytest.ini
README.md
SPIKES.md
tests
THIRD_PARTY_NOTICES.md
tools
web
[0m
[0m$ [0msed -n '1,120p' SPIKES.md; echo ---; cat plugin.yaml
# Spikes S1–S5 — results as measured on 2026-11-04 (dev@callisto-odin)

Status: **S1 fails as written; S2 Linux passes; S4 passes; S3 partially measured; S5 passes with a
caveat.** The consequence is at the bottom: Aura 0.1 does not claim a true backdrop.

## S1 — can a plugin paint behind the app? **NO (verified in source)**

Checked the live tree (`~/.hermes/hermes-agent/apps/desktop`), not the docs:

- Plugin contribution areas are exactly: `panes`, `statusBar.left/right`, `titleBar.center/left/right`,
  `palette`, `appearance.extra`, `chat.empty`, `keybinds`, `sessionRow.*`, `sidebarNavPrefs`,
  `settings.plugins`, `themes`, `routes`, `transcript` (`src/sdk/areas.ts`, `src/sdk/index.ts`).
  **There is no backdrop, wallpaper or full-window layer slot.**
- Core has a private backdrop of its own (`$backdrop` in `src/store/backdrop.ts`: "the faint statue
  image renders behind the chat transcript", toggled in Appearance). It is a core-owned image, not
  exposed to plugins.
- Plugin themes are colour/typography only (`src/themes/types.ts`: `colors`, `darkColors`,
  `typography`, `terminal`, `customCSS`, `accentOf`) — no `assets`, no background image field.
- Translucency is flattened before it reaches the app: `src/themes/color.ts` composites
  `#rrggbbaa` over a backdrop to opaque for all downstream contrast/mix math. So a plugin theme
  cannot promise a see-through window.

**Decision:** Aura 0.1 ships (a) accent pulse from real audio, (b) a full-window **stage** route
(`routes` + sidebar nav) hosting the visualizer, (c) a canvas on the **empty chat** screen, (d) an
optional contributed **theme** whose palette follows the music, and (e) asks Nous for an SDK backdrop
hook rather than patching around it (catalog rule 8). The "MilkDrop behind Hermes" pitch must be
worded as "MilkDrop as an Aura stage that takes over the window, chat still reachable", not
"behind the chat".

## S2 — system-audio loopback

- **Linux: PASS.** `linux-loopback-probe.sh` (null sink, does not touch playback): captured 786432
  bytes = 4.10 s stereo 48k, RMS window `[0, 2972, 8484, …]` — real signal reaches the analyser.
- **Windows:** untested. Planned path = WASAPI loopback (`sounddevice` `WasapiSettings(loopback=True)`
  or `pyaudiowpatch`), pure-Python, no native helper. Must be tested on a real machine before claiming.
- **macOS:** untested and the hardest. ScreenCaptureKit / Core Audio taps need a native helper
  (rule 17 risk). Fallback: a virtual device (BlackHole) or browser tab audio. Ship as "supported
  with a virtual device" and say so plainly.

## S3 — performance under software GL (partial)

Measured in headless Chrome with software GL at 320×240, one Butterchurn preset, 100 presets
available: **12 % of one core** over 8 s. Frame cadence in headless was ~7 fps, so the real desktop
figure must be measured in the app (Daniel) before promising 15–24 fps. Plan stays: low-res render
scaled up, fps cap, auto-fallback to accent-only when the frame budget is missed.

## S4 — PCM → Butterchurn in muted headless Chrome: **PASS**

`python s4_feed.py` (raw CDP, `--mute-audio`, gain 0 so nothing is audible):
- silence: mean 0, lit 0, hash 0 — **no invented motion**;
- 10 s tone: mean 12→20, lit 7445→10422, hash changes — **real signal moves the render**;
- 100 presets load, no page errors;
- verdict line: `tone-moves: PASS | non-blank: PASS`.

This validates the whole audio→visualizer path end to end, which was the riskiest technical
assumption after S1.

## S5 — licences

- `butterchurn@2.6.7` — MIT. `butterchurn-presets@2.4.7` — MIT (package licence; individual
  presets are community MilkDrop conversions — ship a curated subset and credit authors).
- Bundle both with `THIRD_PARTY_NOTICES.md`. Avoid "MilkDrop" in the plugin name (say
  "MilkDrop-compatible" in prose only).
---
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
[0m$ [0mls docs tools; sed -n '1,80p' CONTRACT.md
docs:
council-20261107
council-20261108
PLAN-STUDIO.md
PUBLISH.md
STATUS.md

tools:
__pycache__
record_demo.py
serve_live.py
silence_probe.py
# Aura — wire contract (v0.1, frozen 2026-11-04)

Every lane implements against THIS document. Do not change it without the orchestrator's
agreement: L1 (capture/server), L2 (viz page), L3 (desktop), L4 (hooks/mood) are built in
parallel and only the contract keeps them compatible.

## 1. Server

- Bind `127.0.0.1` only, port **0** (ephemeral, random per process). Never a fixed port.
- Reject any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding guard). Reject unknown paths with 404.
- Token: 32-byte urlsafe random, written to `<HERMES_HOME>/aura/token` mode 0600, regenerated
  on every process start. Never log it, never print it in tool output. Mask it in any preview
  (use `redact.py`).
- Auth: `Authorization: Bearer <token>` for HTTP; `?token=<token>` for the WebSocket only
  (browsers cannot set headers on WS). A missing/incorrect token is 401, never a redirect.
- `GET /healthz` → `{"ok": true, "version": "0.1.0", "pid": <int>, "capture": "pipewire"|"pulse"|"wasapi"|"none", "rate": 48000, "clients": <int>}`
- `GET /api/state` → the newest feature frame (§3) plus `{"enabled": bool, "mood": <mood>, "intensity": <0..1>, "preset": <str|null>}`. Cheap; safe to poll at ≤4 Hz.
- `GET /api/presets` → `{"presets": [{"name": <str>, "family": <str>, "strobe": <bool>}], "default": <str>}`
- `GET /api/config` → `{"intensity": <0..1>, "reduced_motion": bool, "capture": <backend>, "theme_opt_in": bool}`
- `POST /api/control` body `{"enabled"?: bool, "intensity"?: 0..1, "preset"?: <str|null>, "mood"?: <mood>}` → 200 `{"ok": true, "applied": {...}}`; 400 on bad types/out-of-range.
- `GET /api/stream` (WebSocket upgrade, token in query) → server pushes §2/§3 frames. Server closes with 1008 on bad token.
- All JSON is UTF-8, `Content-Type: application/json`. No CORS headers needed: the page is served by this same origin.
- **Static assets** (`/aura.js`, `/pcm-worklet.js`, `/presets.json`, `/vendor/*`) are served
  WITHOUT the token. A browser fetches `<script src>` itself and cannot attach an Authorization
  header, and rewriting every tag with `?token=` is brittle. They contain no secrets; every data
  endpoint and the WebSocket remain token-gated. Paths are whitelisted and confined to `web/`.

Port discovery for the desktop half goes through `dashboard/plugin_api.py` (§5) — never through a
fixed port, a lease file, or a watcher.

## 2. WebSocket frames

**Binary frame = PCM.** Exactly this layout, little-endian:

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `AURA` |
| 4 | 1 | version `1` |
| 5 | 1 | flags (bit0 = silence) |
| 6 | 2 | header length `32` |
| 8 | 8 | sequence (u64, monotonic) |
| 16 | 8 | timestamp ms (u64, monotonic) |
| 24 | 4 | sample rate `48000` |
| 28 | 4 | sample count n |
| 32 | 4*n | float32 LE mono samples, nominal −1..1 |

Frames are ≤ 1024 samples (≈21 ms at 48 kHz). The page feeds them into an `AudioWorklet` and
into a **silent** graph (`gain 0` → destination) so Aura never makes sound. Drop, never queue,
when the socket is backed up.

**Text frame = JSON event.** `{"type": "features"|"mood"|"preset"|"config"|"error", ...}`

- `features`: `{"type":"features","seq":<int>,"ts_ms":<int>,"level":<0..1>,"bands":[8 floats 0..1],"onset":<bool>,"centroid":<0..1>,"flatness":<0..1>,"silence":<bool>}` — at most 10 Hz.
- `mood`: `{"type":"mood","mood":<mood>,"intensity":<0..1>,"ttl_ms":<int>,"seq":<int>}` — emitted on every transition and every 2 s while a non-idle mood holds.
- `preset`: `{"type":"preset","name":<str>,"blend_ms":<int>}` — server-selected preset change.
- `config`: `{"type":"config", ...same as /api/config}` — pushed when control changes state.
- `error`: `{"type":"error","code":<str>,"message":<str>}` — e.g. `capture_lost`.

Client→server text frames are accepted and ignored except `{"type":"ping"}` → `{"type":"pong"}`.

## 3. Feature frame (analysis output)

`level` = RMS mapped to 0..1 on a −60..0 dBFS scale, clamped; `bands` = 8 octave-ish bands
(63/125/250/500/1k/2k/4k/8k Hz) normalized per-band by a slow AGC so a quiet passage still
moves; `onset` = transient detected this frame; `silence` = true when level < 0.02 for > 300 ms.
Analysis is local, in-memory, never written to disk, never sent off-machine.

## 4. Moods

`idle | thinking | tool | approval | error | streaming | done`. Semantics and caps live in
`aura_core/mood.py` (L4 owns it). Rules that every consumer must honour:

- `approval` and `error` are attention moods: intensity ≥ 0.6, but their pulse rate is capped at
  2 Hz and `ttl_ms` expires back to the previous mood (restore-on-clear), never latched forever.
- `done` is one short settle (≤ 1.5 s) then `idle`.
- When Aura is disabled or the page is gone, mood state must not survive: a fresh `/api/state`
  after re-enable starts at `idle`.
- Mood never changes the audio graph (Aura does not duck, pause, or play anything).
[0m
[0m$ [0mls docs/council-20261108 docs/council-20261107; sed -n '1,60p' docs/STATUS.md
docs/council-20261107:
BRIEF.md
claude.md
codex.err
codex.md
deepseek.md
grok.md
SYNTHESIS.md

docs/council-20261108:
BRIEF.md
codex.err.log
codex.md
deepseek.md
# Aura — build status

Machine-readable checklist for the 5-minute progress reports. Weights sum to 120 and are
normalised to 100 %. `done` is the honest completion fraction (0.0 = untouched, 1.0 = verified by
a real command, not by a claim). Remaining % = Σ(weight × (1 − done)) ÷ 120 × 100.

Deadline: hackathon submission **Nov 11, 17:00 EST**; catalog PR target **Nov 9**.
Repo: /mnt/homes/Development/hermes-aura; private GitHub origin `KeyArgo/hermes-aura-live-dev`.

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
[0m
**Ranked by leverage (each answers your questions):**

1. **Fix the real-app gap first (Q5 — biggest risk).** The losing scenario is a judge opening Hermes, seeing nothing, and calling it vaporware: in-app verification is 0.00, the stage is "unavailable in the real app," and the visual is off by default. Before anything else, run one real Hermes session and verify the backdrop iframe, accent restore, and dispose; add a first-run "See Aura" button with a 10s showcase. If the backdrop is still blocked, lead with the stage route/empty-chat canvas and say so honestly. Windows is unverified—don't claim it.

2. **Defaults (Q1): agent+music, intensity 0.45, balanced, opacity 0.30–0.35 with scrim.** Add a low idle-ambient floor (~0.25) so first launch is never dead; music/agent escalate from there. Ambient-only hides the product; 50%+ opacity kills chat contrast. Pair with the showcase CTA so "wow" comes from a guided moment, not a risky default.

3. **Agent-state visual language + demo (Q4).** (a) Ship a documented mood→look map: tool=mechanical grid, approval=warm 2 Hz ring + accent pulse, error=red glitch/shatter, done=bloom settle, thinking=slow drift. (b) Make `aura_control` discoverable as "stage direction" with example prompts. (c) Record a 60–90s scripted clip: tool→error→approval→done, music-synced. (d) Status-bar "record 15s" → mp4/gif for X/Discord. (e) Curated preset packs by family. Bonus for Nous judges: PR the backdrop SDK hook.

4. **Theme coexistence fade (Q2): good idea, ship with hysteresis.** Fade in only after 300ms of sustained activity; fade out after 2.5s idle; opacity ramp ≤1.5s; debounce streaming tokens (don't pulse per token); cap 0.35 + scrim; ≤200ms transition under reduced motion; single stylesheet toggle, restore on dispose. Real trouble is flicker and contrast on light themes—test both.

5. **Motion-sickness mode (Q3): stricter than "calm."** Exclude strobe/camera/zoom/rotation presets, clamp bass displacement and beat flashes, fixed horizon, ≥800ms fades, 15–20 fps cap, no palette cycling, auto-enable from `prefers-reduced-motion`, pause on window blur.
