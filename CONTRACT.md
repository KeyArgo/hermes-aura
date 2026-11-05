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
| `opacity` | number 0..1 | 0.75 | non-numeric/bool -> `opacity_must_be_number`; outside 0..1 -> `opacity_out_of_range` |
| `behavior` | `"calm"` \| `"balanced"` \| `"intense"` | `"balanced"` | non-string -> `behavior_must_be_string`; unknown -> `bad_behavior` |
| `mood_reactive` | bool | `true` | non-bool -> `mood_reactive_must_be_bool` |
| `accent_pulse` | bool | `true` | non-bool -> `accent_pulse_must_be_bool` |
| `auto_preset` | bool | `true` | non-bool -> `auto_preset_must_be_bool` |

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
