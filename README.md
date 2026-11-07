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
