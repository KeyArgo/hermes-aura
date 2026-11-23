# Changelog

## Unreleased

- The greyed "Behind chat — coming soon" pill is gone from Watch in and both Send to rows: the backdrop is
  removed outright, with nothing in the UI pointing at it.
- Desktop window and mode-switch races: two clicks at once open one window (one shared operation lock, the
  lease written with the pid), a reused pid is never signalled for holding the profile, a stalled page swap no
  longer hides a server refusal or survives a hot reload, and Off cannot re-adopt the window it is closing.
- Desktop: the visualiser's watch window switches off when the Desktop window takes the picture; a mode
  switch and the ownership poll no longer open two windows; Off sends one close; errors in Visualizer
  mode say "visualiser window"; a relaunch after freeing the profile uses a fresh one-time ticket.
- The REVamp card's Copy button gives `hermes plugins install …` (the old `hermes plugin` is not a command).
- Desktop: a window left open by the previous Aura server no longer blocks the next one. The launch
  finds it (the lease, or the profile's own lock), closes it only when the process really runs on
  Aura's profile, and retries once; when the browser still will not start, the plugin shows the
  server's sentence in the pane instead of falling back to the in-app window without a word.
- Off now stays off when a /status check starts during the on/off switch's own request and answers with the old switch.
- Removed the full-window backdrop. It returns when Hermes ships an SDK backdrop area (#155903).
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
- Watch in and the watch window's Send to row show Behind chat, greyed out, as coming soon.
- In Visualizer mode the watch window carries the film window's Size presets and its Send to row:
  Panel returns the visualiser to the Right panel, Desktop opens it in the desktop OS window, and
  Behind chat stays the greyed coming-soon pill. The film's own rows are unchanged.

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
