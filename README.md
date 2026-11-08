# Aura

A living, audio-reactive theme for Hermes Desktop. Aura listens to **system audio** —
whatever this computer is already playing, from any app — analyses it locally, and
drives a MilkDrop-compatible visualizer plus the app's accent colour from it. It also
reacts to the agent: thinking, tool runs, approval waits, errors and finishes each have
a mood.

REVamp only reacts to audio REVamp itself plays. Aura needs no account, no music
integration and no playback of its own: it works with anything the machine is playing.

## What it does (0.1)

- **Visual behind the app (opt-in, off by default)** — one click-through, audio-reactive
  backdrop iframe behind the whole window plus a single `#aura-glass` stylesheet that clears the
  app's big surfaces so the visual shows through. Switching it on while Aura is off turns Aura on
  too. The old full-page stage (`/aura` route, sidebar row, palette command, compact pane) was
  removed: the backdrop and the Settings page are the product.
- **Accent pulse (opt-in, off by default)** — Hermes's accent colour follows the music (≤ 4 Hz,
  derived from your *current* theme so it composes with whatever skin you use; restored on disable).
  Turn it on in Aura settings; Restore my theme turns it off and clears the override.
- **Agent moods** — thinking / tool / approval / error / streaming / done, with
  restore-on-clear so nothing latches.
- **Display controls** — opacity, a behaviour profile (calm / balanced / intense; calm is
  reduced-motion-safe and never uses strobe presets), a motion source (default / music only /
  agent activity / agent + music), and switches for agent-mood reactions, accent pulse and
  automatic preset rotation. Settable by you or by the agent.
- **Optional Aura Live theme (opt-in, off by default)** — a deep-stage palette. While it is the
  active theme it also drives the window backdrop. Your previous theme is restored when you turn
  it off, and **Restore my theme** disables every accent/theme/window-visual effect and cleans up.
- **Motion that fits the room** — the default follows playback and rests on gentle designs after
  1.5 s of silence; music-only settles when nothing is playing; agent activity moves only while
  the agent is working and pauses after 2.5 s idle; agent + music also follows playback and pauses
  only when the agent is idle and the room is silent. The legacy designs-only value still works.
- **Optional theme** — an Aura theme whose palette follows the audio. Opt-in; disabling
  restores the theme you had before.
- **`aura_control`** — the agent can turn Aura on/off, set reaction strength, opacity,
  behaviour and motion, pick a preset, set a mood.

## Host safety

The only host DOM Aura touches is gated behind an opt-in: while "Visual behind the app" (or the
Aura Live theme) is on and Aura is enabled, it mounts one fixed, click-through, negative-z
backdrop iframe and a single `#aura-glass` stylesheet. Switching the visual off, turning Aura
off, **Restore my theme** and dispose remove both; while nothing is opted in nothing is injected
at all, and the host `html`/`body`/root styles are never written. The accent override is the
SDK's sanctioned, opt-in mechanism. Accent pulse and the Aura Live theme are off by default.
**Restore my theme** turns the window visual, accent pulse and theme off, clears the accent
override, restores your previous theme, and removes any effect Aura applied.

## Privacy and safety

- Use Aura settings — the "Visual behind the app" switch, or "Aura enabled" — to stop the visual.
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
