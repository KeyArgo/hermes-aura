<p align="center">
  <img src="assets/brand/mark.svg" width="88" height="88" alt="InovinLabs"/>
</p>

<h1 align="center">Aura</h1>

<p align="center"><em>A living, audio-reactive theme for Hermes Desktop. It listens to what your machine is already playing, and moves.</em></p>

<p align="center">
  <img alt="Hermes plugin" src="https://img.shields.io/badge/Hermes-plugin-0000F2?style=flat-square"/>
  <img alt="Licence" src="https://img.shields.io/badge/licence-MIT-0000F2?style=flat-square"/>
  <img alt="Built by InovinLabs" src="https://img.shields.io/badge/built%20by-InovinLabs-0000F2?style=flat-square"/>
  <img alt="Tests" src="https://img.shields.io/badge/tests-coming%20soon-lightgrey?style=flat-square"/>
  <img alt="Platforms" src="https://img.shields.io/badge/Linux-verified-0000F2?style=flat-square"/>
</p>

> **Status: pre-release (0.1).** The code, tests and screenshots land here after the current pass and a
> green regression suite. This page describes what the release is and what has been measured so far.

## What it is

Aura reads the audio your computer is already playing, analyses it locally, and drives a
MilkDrop-compatible visual behind the Hermes window plus the app's accent colour. It reacts to the
agent too: thinking, tool runs, approval waits, errors and finishes each have a mood.

## Why it is different

**It works with system audio, not a music player.** Aura captures the loopback of whatever is playing,
from any application, and needs no account, no music integration and no playback of its own. The
capture is loopback only and never opens the microphone.

Everything is analysed in memory. Nothing is written to disk and nothing is sent anywhere.

## What it does

- **Visual behind the app.** A click-through backdrop behind the whole window plus one stylesheet that
  clears the app's large surfaces so the visual shows through. Off by default.
- **Accent pulse.** The accent colour follows the music at up to 4 Hz, derived from your current theme
  so it composes with whatever skin you use, and restored when you turn it off. Off by default.
- **Agent moods.** Thinking, tool, approval, error, streaming and done, each with a mood, and
  restore-on-clear so nothing latches.
- **Only while active.** The backdrop exists only while the visual is moving. It fades in after 300 ms
  of sustained activity, survives the short gaps between tool calls, then fades out and is removed, so
  your own theme surfaces come back exactly as they were.
- **Display controls.** Opacity, three behaviour profiles (calm, balanced, intense), a motion source,
  and switches for moods, accent pulse and preset rotation. Settable by you or by the agent.
- **`aura_control`.** The agent can turn Aura on or off, set strength, opacity, behaviour and motion,
  pick a preset, or set a mood.

## Host safety

The only part of the host Aura touches sits behind an opt-in. While the visual is on and Aura is
enabled, it mounts one fixed, click-through backdrop and one stylesheet. With **Only while active**,
both exist only while the visual moves and are removed once the fade-out finishes. Turning the visual
off, disabling Aura, **Restore my theme** and dispose all remove them. While nothing is opted in,
nothing is injected at all, and the host `html`, `body` and root styles are never written.

## Try it in five minutes

Pending the first push. The install steps will be:

```bash
hermes plugins install inovinlabs/hermes-aura --enable
```

Then open Settings, choose Aura, and switch on **Visual behind the app**. Aura starts off; switching
the visual on turns it on with it.

## Limits

- **Linux** is the tested platform. **Windows** loopback is implemented but needs a real-machine test
  before it is claimed. **macOS** needs a virtual audio device such as BlackHole; there is no native
  helper.
- It reacts to what the machine plays. On a machine with no audio output there is nothing to drive it.
- The visual is decoration. It never alters, ducks or routes your audio.
- Presets come from Butterchurn. The calm profile is reduced-motion safe and never uses strobe presets.
  The intense profile is more demanding on purpose.
- Nothing is recorded, so there is no history: Aura shows the present only.

## Tests

Pending the first push. The suite runs with:

```bash
python3 -m pytest tests -q
```

The release will not be tagged until the number is reproduced from a clean clone of this repo.

## Platform support

| Platform | Status |
| --- | --- |
| Linux | Verified: PipeWire and PulseAudio monitor capture |
| Windows | Implemented, not yet verified on a real machine |
| macOS | Not supported without a virtual audio device |

## Privacy

Loopback capture only, never the microphone. Analysis happens in memory. Nothing is recorded to disk
and nothing leaves the machine. No account, no telemetry, no stored passwords.

---

Built by [InovinLabs](https://github.com/inovinlabs). Also in the suite:
[Omniscience](https://github.com/inovinlabs/hermes-omniscience),
[Game Center](https://github.com/inovinlabs/hermes-game-center) and
[REVamp](https://github.com/inovinlabs/hermes-revamp).
