# Aura — wire contract

How Aura's four parts talk to each other: the capture server, the visualiser page, the Desktop half
and the mood hooks. Each part is built and tested against this document, so a change here is a change
to all four.

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
- `GET /api/state` → the newest feature frame (§3) plus `{"enabled": bool, "mood": <mood>, "intensity": <0..1>, "preset": <str|null>, "reduced_motion": bool, ...}`. Cheap; safe to poll at ≤4 Hz.
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

## 5. `dashboard/plugin_api.py` (port discovery)

The desktop half and the agent tool must never guess a port. This module is the single door:

- `GET /status` (through `/api/plugins/aura/status`) → `{"ok": bool, "port": <int|null>, "url": "<http://127.0.0.1:port/?token=…>", "capture": <backend>, "enabled": bool}`. The URL carries the token, so the desktop half can hand it straight to an iframe; the agent tool must redact it before showing it to the model.
- `POST /control` → forwards to the server's `/api/control`.
- The module imports the server module and asks it for its live port; it does not spawn a second server.

## 6. Failure behaviour (must be implemented, not described)

- No capture device → server still serves, `/healthz.capture == "none"`, features are all-zero
  with `silence: true`; the page shows a clear one-line message and falls back to accent-only.
- No WebGL / software GL → the page renders at reduced resolution and caps fps (see SPIKES.md S3),
  or shows the message if WebGL is absent entirely.
- Token mismatch → 401 / WS 1008, never a blank frame with no explanation.

## 7. Internal Python API (agreed between L1 and L4; import from `aura_core.server`)

The plugin glue and the desktop port-discovery module must not reimplement the server. L1
provides, in `aura_core/server.py`, module-level functions:

- `ensure_server() -> None` — start the server in a daemon thread if it is not running. Idempotent,
  never blocks `register()` for more than ~100 ms.
- `get_port() -> int | None` — live port, or `None` when the server has not started.
- `publish_mood(mood: str, intensity: float, ttl_ms: int) -> None` — queue a mood transition for
  connected pages; no-op when there are no clients. Must never raise into a hook.
- `publish_config() -> None` — push the current config after a control change.
- `stop_server() -> None` — clean shutdown: close sockets, join threads, leave no process/port.

L4 calls only these. L1 must keep them safe to call from any thread, and must make every one of
them swallow-and-log exceptions (a broken capture must never break an agent turn).

### 7.1 Single server per `HERMES_HOME`

Only one Python process/module copy serves a given `HERMES_HOME`. Leadership is elected with
`fcntl.flock(LOCK_EX | LOCK_NB)` on `<HERMES_HOME>/aura/server.lock` (0600), and the fd is held for
the server's lifetime. Because `flock` is per open file description, two copies of the module inside
one process also exclude each other.

- The leader binds the socket, starts capture, writes `<HERMES_HOME>/aura/token`, and advertises
  itself in `<HERMES_HOME>/aura/lease.json` (0600, atomic replace):
  `{"pid", "port", "token", "started", "capture"}`. The token is never logged.
- A follower does not bind or capture. `get_port()`, `get_token()` and `get_capture()` return the
  leader's values from `lease.json`, but only while that `pid` is alive; otherwise they return
  `None` / `"none"`.
- `ensure_server()`, `get_port()` and every publish retry the lock at most once per 2 s; if the
  leader has died, the follower acquires the lock and becomes the new leader (new token, new lease).
- `stop_server()` releases the lock and removes `lease.json` only when the lease belongs to this
  process/token.
- Follower forwarding: `publish_mood` POSTs `{"mood","intensity","ttl_ms"}` to the leader's
  `POST /api/mood`; `publish_config` POSTs `{}` to `POST /api/config/push`. Both use the bearer
  token, run in a daemon thread with a 0.5 s timeout, and swallow every error (a hook never blocks
  or raises). The leader's handlers call the local `publish_mood` / `publish_config`.

## 8. Non-goals for 0.1

Playback, music sources, DJ voice, multi-device sync, cover art, recording to disk, network
audio. Aura only listens to what the machine is already playing.

## 9. Display controls (additive, 2026-11-05)

Additive to §1/§2/§4. No existing field changed meaning. New config keys are persisted in
`<HERMES_HOME>/aura/config.json`, returned by `/api/config` and `/api/state`, carried in every
`config` event, and accepted by `POST /api/control` (400 on bad type/range, same style as
`intensity`).

### 9.1 Keys

| key | type | default | validation |
|---|---|---|---|
| `opacity` | number 0..1 | 0.35 | non-numeric/bool -> `opacity_must_be_number`; outside 0..1 -> `opacity_out_of_range` |
| `behavior` | `"calm"` \| `"balanced"` \| `"intense"` | `"balanced"` | non-string -> `behavior_must_be_string`; unknown -> `bad_behavior` |
| `mood_reactive` | bool | `true` | non-bool -> `mood_reactive_must_be_bool` |
| `accent_pulse` | bool | `false` | non-bool -> `accent_pulse_must_be_bool` |
| `auto_preset` | bool | `true` | non-bool -> `auto_preset_must_be_bool` |
| `reduced_motion` | bool | `false` | non-bool -> `reduced_motion_must_be_bool` |
| `motion` | `"designs"` \| `"both"` \| `"music"` \| `"agent"` \| `"agent_music"` | `"agent_music"` | non-string -> `motion_must_be_string`; unknown -> `bad_motion`; `designs` stays accepted (legacy) but is no longer offered in the desktop select |
| `idle_motion` | `"stop"` \| `"ember"` \| `"always"` | `"always"` | non-string -> `idle_motion_must_be_string`; unknown -> `bad_idle_motion`; accepted case-insensitively (§9.7) |

All defaults above are first-run only: a saved `config.json` keeps its own values and a
corrupt/missing key alone falls back to the default.

`/api/config` and `config` events additionally carry `behavior_profile` — the concrete mapping
below, so a page never has to guess. Corrupt/missing config values are coerced to defaults on
load; only `/api/control` rejects with 400.

### 9.2 Opacity

The page applies `opacity` to the visualizer canvas and computes the scrim from it. The scrim's
element opacity is `0.85 + 0.15 * opacity` (0.85..1.0) and its gradient alphas are multiplied by
the inverse of that opacity, so the scrim's effective contrast is never below the pre-opacity
behaviour at any user opacity, and neither layer is ever fully transparent. Text and control
chrome are separate elements and are not dimmed. Live application only; no restart, no reload.

### 9.3 Behaviour profiles

Measured parameters (also in `aura_core/behavior.py` and `web/aura.js`):

| parameter | calm | balanced | intense |
|---|---|---|---|
| intensity ceiling | 0.60 | 1.00 | 1.00 |
| pulse rate ceiling (Hz) | 0.0 (no hard pulse) | 1.0 | 2.0 |
| preset-family preference | organic | liquid | geometric |
| preset blend time (ms) | 2400 | 1200 | 600 |
| mood gain scale | 0.35 | 1.0 | 1.35 |
| strobe presets allowed | no | yes | yes |
| hard pulses | no (static wash) | yes | yes |

`calm` is the reduced-motion-safe profile: no strobe presets, the lowest ceiling and no hard
pulses; an attention mood still shows a static accent wash.

Hard invariants every profile keeps: attention pulse ≤ 2 Hz (the page additionally clamps
`pulse_hz_max` to 2), flash limiter ≤ 3 flashes/s, `done` settles to idle within 1.5 s,
restore-on-clear, and mood never touches the audio graph. `mood_reactive=false` makes the server
hold `idle` (no latched mood, no leftover pulse); `auto_preset=false` makes the page ignore
`preset` rotation events while manual presets (delivered through the `config` event) still
apply. All three toggles can be turned back on live without a reload.

### 9.4 Agent tool

`aura_control` forwards to `/api/control`, so `opacity` and `behavior` are settable by the agent
with no extra plumbing.

### 9.5 Motion source

`motion` selects what drives the visual. `both` and `music` keep their existing behaviour.
`agent_music` is the default. `designs` is legacy-accepted and behaves as designs-only.

- `agent`: the ambient designs drive the visual only while the agent is active. Agent activity is
  the RAW mood stream: `thinking`, `tool`, `streaming`, `approval`, `error`, and `done` until it
  settles. When the raw mood is `idle`, the canvas pauses (`pauseVisual()`).
- `agent_music`: moves while the agent is active (ambient designs) OR while real audio is playing;
  real audio wins when both are present. Paused only when the agent is idle AND the capture is
  silent.
- Resume is immediate on an active mood event (same tick, well under 1 s).
- Pause waits `AGENT_IDLE_GRACE_MS` = 2500 ms of raw idle so tool-call gaps do not flicker; any
  new active mood cancels the pending pause.
- The gate uses the raw mood independently of the mood visuals: `mood_reactive=false` forces the
  visual mood to `idle` but does not freeze `agent`/`agent_music`.
- At page load, if `/api/state` (or the first events) reports an active mood, the visual starts
  moving. Disabled Aura behaves as before.

### 9.6 Dynamic intensity from active chats (additive, 2026-11-08)

More open Hermes chats make Aura more intense, on top of the user's saved intensity. The saved
`intensity` value is never overwritten; the boost is a separate multiplier on the rendered
intensity.

- Session count source: Hermes' existing cross-process active-chat registry
  (`<HERMES_HOME>/runtime/active_sessions.json`). The server prefers Hermes'
  `hermes_cli.active_sessions.active_session_registry_snapshot()` (which prunes dead leases) and
  falls back to a tolerant stdlib reader that ignores entries whose owner pid is dead. No new
  external API or network call is introduced.
- Boost formula: `multiplier = 1 + 0.15 * min(N, 10)` where N is the number of live active chat
  sessions. 0 sessions = 1.0x, 1 = 1.15x, 5 = 1.75x, 10+ = 2.5x. The rendered intensity is
  `min(1.0, saved_intensity * multiplier)`, so it saturates at the contract ceiling; the active
  behaviour profile's `intensity_ceiling` still applies after saturation.
- The leader server polls the registry every 2 s. When the count or multiplier changes it
  broadcasts the existing `config` event with two additive fields:
  `{"type":"config", ..., "sessions": <int>, "session_boost": <1.0..2.5>}`. `/api/state` and
  `/api/config` carry the same two fields. A `config` event is only sent on change, so an idle
  desktop is not chattered at every poll.
- The page stores the multiplier separately (`state.sessionBoost`) and applies it in
  `effectiveIntensity()`; the intensity slider continues to show and edit the user's saved base.
  `mood_reactive`/`enabled` behaviour is unchanged: disabled Aura renders at zero base, and mood
  gains apply on top of the boosted base exactly as before.

### 9.7 Idle motion (additive, 2026-11-10, plugin 1.0.0)

What the visual does between agent turns, when the mood is `idle` or `done`:

| `idle_motion` | render gain while idle/done | desktop label |
|---|---|---|
| `always` | unchanged (pre-1.0.0 behaviour, the default) | Keep moving |
| `ember` | `IDLE_EMBER_GAIN` = 0.06 — a low ember glow, never dark | Ember — a low glow |
| `stop` | 0 — the visual rests | Stop — go dark |

- Precedence: an attention mood (`approval`, `error`) always renders at full gain, whatever
  `idle_motion` says; the gate beats the `motion` source choice (`real` vs `ambient`).
- The gate multiplies the existing `realGain`/`ambientGain` crossfade (`MOTION_FADE_S`), so
  there is no second render path and no new audio node. A mood change re-eases the gate in the
  same tick; `snapshot()` exposes `idleMotion` and the live `idleGate()`.
- Default `always` means an existing install behaves exactly as before the key existed.

## 10. Silence gate (additive, 2026-11-05)

Butterchurn presets advance on their own internal clock as well as the audio, so a bright preset
keeps glowing after capture stops. Measured in muted headless Chrome: with silence-only PCM and
`features.silence=true`, 20 of 21 curated presets stayed lit (mean 24..155 of 255).

The page therefore treats audio as the thing being visualised, not as a garnish:

- `feedPcm()` and `features` events are the only sources of audio presence. A frame with
  `flags & 1` (silence) or `features.silence=true` does **not** count.
- After `SILENCE_MS` = 1200 ms with no audio presence, the canvas fades out over
  `SILENCE_FADE_MS` = 600 ms and its WebGL drawing buffer is cleared; `viz.render()` stops being
  called (the rAF loop keeps ticking but does nothing) and `snapshot().silent` becomes `true`.
- Any non-silent frame resumes rendering immediately at the user's `opacity`; no reload, no
  preset reload, and the mood/preset state is preserved across the pause.
- The gate is subordinate to `enabled` and to a hard blocker: when Aura is off or the GPU has
  fallen back, the canvas is hidden anyway.
- `__aura.sampleNow()` honours the gate (it clears instead of rendering), so a measurement never
  wakes a paused preset up.

Consequence for testing: a silence assertion is now a test of the gate, not of a lucky preset.
`tools/silence_probe.py` measures the whole curated set (21/21 dark, mean 0, lit 0.000).

## 11. Host safety (additive, 2026-11-08)

Aura owns no host document styles beyond one sanctioned, opt-in visual: while "Visual behind the
app" (or the Aura Live theme) is on, Aura is enabled and a tokenised URL is live, the desktop half
mounts exactly one fixed, click-through, negative-z backdrop iframe and one `#aura-glass`
stylesheet that clears the app's big surfaces so the visual shows through. Switching the visual
off, turning Aura off, **Restore my theme** and disposal remove both; while nothing is opted in no
host node or style is added at all, and the host `html`/`body`/root styles are never written.

The accent pulse and the optional Aura Live theme are opt-in and off by default. **Restore my
theme** turns the window visual, the accent pulse and the theme off, clears the accent override
through `setAccentOverride(null)`, restores the previous theme, and removes every effect Aura
applied. Disposal does the same and also removes all contributions, timers and listeners.

The full-page stage (the `/aura` route, sidebar row, palette command and compact pane) was removed
by owner decision: the backdrop and the Settings page are the product. The desktop half now
contributes only the settings page, the theme, the backdrop, the accent pulse, the titlebar theme
probe and polling. If "Visual behind the app" is switched on while Aura is off, the desktop half
enables Aura through the same door as the "Aura enabled" switch (writeSettings + `POST /control
{enabled:true}`), so the visual never silently draws nothing.

## 12. Capture gate (additive, 2026-11-10, plugin 1.0.0)

No recorder is opened unless the visual actually needs audio:

- A capture backend opens only while `enabled` is true **and** `motion` is one of `both`,
  `music`, `agent_music` (`server._audio_wanted()`). `designs` and `agent` never open one.
- The capture loop re-reads the config every `CAPTURE_GATE_S` = 0.5 s. Turning Aura off (or
  switching to an audio-free motion) closes the recorder within half a second and pushes a
  `config` event, because the open page still shows "no system audio"; switching back reopens
  it at once instead of waiting out `CAPTURE_RETRY_S` (10 s).
- A replaced recorder is always closed (`_swap_capture()`), so neither the gate nor the silent
  retry path can leak a device handle.
