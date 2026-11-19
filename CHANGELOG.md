# Changelog

## Unreleased

- Off now stays off when a /status check starts during the on/off switch's own request and answers with the old switch.
- **Behind chat is back, as an opt-in.** "Watch in" and the watch window's "Send to" row end with a
  real Behind chat choice: the film plays in ONE click-through iframe at z-index -1 on the host body,
  with a scoped `#aura-glass` stylesheet so the app's surfaces let it through. It exists only while
  that place is chosen for an open film and Aura is on; Panel, a close, an Off or dispose take the
  iframe, the stylesheet and the `data-aura-backdrop` attribute away again. The default surface is
  still the Right panel, and nothing is drawn behind the chat unless you pick it.
- Removed the optional Aura Live theme.
- Stop closes the film, and its desktop window, instead of leaving it on screen.
- Radio plays in the Right panel, the Aura page, and the watch window, in every mode.
- Aura stops polling when it is not being used. The 4 Hz tick used to cost the backend ~12-16
  requests a second all day — also with Aura switched off and the window hidden ("Aura is eating my
  CPU and I'm not even using it"). The tick stays at 4 Hz; the network call now only happens while
  Aura is busy (switched on, a film or the visualiser on screen, radio or music playing, a desktop
  window open, or ten seconds after a click or an agent request), every 2 s while idle, and every
  3 s while the Hermes window is hidden — an agent "play this" is discovered within ~3 s even with
  Aura idle and hidden. While hidden with radio or a film playing it polls every second — the
  levels are live but nobody sees them, and a command still lands within a second. Every cadence,
  busy included, is held to the same interval check. Routine frame reports (position/level
  telemetry at 4 Hz) no longer count as "using Aura": only a real change — playback starting, a new
  source, a seek, an error or the end of a film — keeps the fast cadence, so a mounted visualiser
  frame cannot hold polling hot forever.
- A new Aura build no longer switches Aura on over a saved Off. If the saved settings say
  enabled:false — whether the user, the server or an older build wrote it — an update leaves it
  off. Only a first install with no saved settings at all starts switched on.
- The Aura page stops drawing when nothing is visible: the render loop parks while Aura is off, the
  silence gate has faded the visual out, a blocker hides it, or the tab is hidden, and resumes on the
  same tick when it can draw again. The blocking GPU sync probe now only samples during the first
  ten seconds after a start or a quality change the user asked for, then once every 120 frames.
  Preset loads (including mood/agent changes) and the automatic quality ladder no longer re-open
  that window, so the stall cannot come back all evening. Nothing on screen changes.
- Watch in and the watch window's Send to row end with a real Behind chat choice (it used to be a
  greyed "coming soon" pill): the film plays behind the chat while that place is chosen.

## 1.0.0 — 2026-11-11

First public release.

- **Watch while you work:** a docked film pane for YouTube videos, YouTube playlists and direct
  MP4/WebM, with per-film resume, playlist episodes, auto-skip of unplayable items and a floating
  watch window.
- **A visualiser that listens:** a MilkDrop-compatible WebGL visualiser (Butterchurn, 140 presets)
  driven by system audio, with silence gating, room-following opacity and a calm mode.
- **Agent moods:** thinking, running tools, waiting for approval, erroring, streaming and finished,
  each restoring itself.
- **Agent tools:** `aura_control`, `aura_listen`, `aura_watch`, with keyless YouTube search.
- **Audio capture:** Linux (PipeWire / PulseAudio monitor) and Windows (WASAPI loopback through
  `soundcard`, installed automatically on Windows). macOS needs a virtual audio device.
- **Private by design:** loopback only, never the microphone; audio is analysed in memory and never
  recorded or uploaded.
