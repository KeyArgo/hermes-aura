# Changelog

## Unreleased

- Removed the full-window backdrop. It returns when Hermes ships an SDK backdrop area (#155903).
- Removed the optional Aura Live theme.
- Stop closes the film, and its desktop window, instead of leaving it on screen.
- Radio plays in the Right panel, the Aura page, and the watch window, in every mode.
- Aura stops polling when it is not being used. The 4 Hz tick used to cost the backend ~12-16
  requests a second all day — also with Aura switched off and the window hidden ("Aura is eating my
  CPU and I'm not even using it"). The tick stays at 4 Hz; the network call now only happens while
  Aura is busy (switched on, a film or the visualiser on screen, radio or music playing, a desktop
  window open, or ten seconds after a click or an agent request), every 3 s while idle, and every
  15 s while the Hermes window is hidden. Nothing gets slower while something plays.

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
