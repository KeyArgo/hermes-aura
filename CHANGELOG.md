# Changelog

## Unreleased

- Closing the "Manage playlist" window no longer leaves both stages blank. The pop-out stayed "in flight", so the panel, page and watch window drew nothing and polling stayed at 4 Hz until Aura was restarted; a closed desktop window now settles that flag too.
- Moving the film between the Right panel, the Aura page and the watch window — or resizing or
  re-cornering the watch window — no longer restarts it at `0:00`. The surface being drawn again was
  handed the running player's address, which still carried the bookmark from when the film booted (or
  no start point at all), so its new player began at the top at its own volume; a film that moves now
  gets an address with the position it is actually at, and the strip re-sends the volume and the seek
  to the new frame.
- Popping the film out to the Desktop window resumes its saved bookmark and episode instead of starting
  at 0:00 / episode 1, and closing a Visualizer Desktop window no longer erases that bookmark or reopens
  a closed film.
- The popped-out film window follows every control on the strip. Picking another film, Next/Previous on
  a single film, muting and **Close video** now reach the OS window instead of the parked in-app frame:
  the new film loads there (`load` on the command queue), the arrows walk the source queue, `mute`/`unmute`
  are real queue commands the window's player applies, and Close closes the window instead of leaving it
  playing while the strip says the film closed. Closing it no longer reverts the chosen film either.
- Radio keeps a surface after the film is closed from the watch window. A closed film took the window's
  card away while the surface still claimed the window, so no frame mounted anywhere and play reported
  "Music needs Aura's panel or page open" with the Right panel open; the carrier goes to the panel now.
- Muting or unmuting a film no longer reloads it. The player address comparison kept `mute` in the
  identity, so every toggle (an agent's `mute_video`, the in-app volume slider, the player's own mute
  report) rewrote the surface `src` on the next poll tick: the `<iframe>` reloaded from scratch, the
  film jumped back to its 5 s bookmark and the radio playing inside that document restarted. Mute now
  travels only as a live transport message; a film first placed while muted still carries `mute=1`.
- The saved film volume now reaches the player in every placement, not just the watch window: the
  Right panel and the `/aura` page carried their own transport, so their films opened at the player's
  own 100% with the slider showing the saved level. Closing and reopening the same film, or restarting,
  sends it again, and a muted film comes back muted.
- Turning Aura off, closing the film or hiding the Right panel no longer leaves the film or the radio
  marked as playing. The frame that reported it is unmounted on the click, so no later report could say
  otherwise: Aura kept polling at 4 Hz all day with nothing on screen (1 Hz hidden) and every Play button
  stayed on pause. Off and Close video now retract the state themselves, and a hidden panel retracts it
  when it was the last surface.
- A profile switch mid-poll no longer leaks the previous profile into the new one. An in-flight
  `/status`, `/state`, `/player` or on/off answer is dropped once the instance that asked for it is
  gone, so the old profile's display controls, server URL and Off cannot land on the next, and a
  `/control` left in flight no longer keeps the new profile from trusting its own `/status`.
- Reloading the visualiser pop-out keeps the visualiser. The window loads with a one-time ticket and the
  page scrubs that ticket from its address before drawing, so Ctrl+R asked for the document with nothing
  left to authenticate with and got a 401 body in place of the page; an authorised page load now also
  leaves a document-only cookie (a per-server key, never the token) that reopens the page on reload.
- Opening the pop-out no longer stalls the rest of the dashboard. `/window/open` is an `async` route that
  called the blocking forward in place, so the dashboard's event loop sat out the launch (1.5 s even on a
  working launch, up to the proxy's 15 s) with every other request queued behind it; that forward and the
  other async ones (`/window/close`, `/window/manage`, `/player/report`, `/player/command`, `/control`) now
  run in a worker thread.
- A config saved as UTF-16 (or with a BOM) is read as defaults, not raised out of the reader: the
  capture thread survives it and `/api/config` answers, and the next control change rewrites the file
  as UTF-8.
- Recovering a dead HTTP listener no longer leaves the previous audio capture running: the restart signals the replaced server's stop event and joins its capture loop, so its recorder closes before the successor opens one and `stop_server()` leaves nothing capturing.
- Windows capture follows the default output. The loopback opened the speakers once and stayed bound to
  them, so switching the default to headphones while the old device kept playing left the visualizer
  reacting to the old one; it now re-reads the default about once a second and reopens on the new device.
- A dashboard `status` poll as a follower now shows the capture backend that came back after start. The
  lease is what a follower reads the backend name from, and lease maintenance compared only pid, port and
  token, so a leader that started before its audio device existed kept advertising `capture: "none"` while
  its visualizer reacted to real audio; the live capture name is now part of the check.
- A newly reported film opens at its own start. A report that only named a new URL dropped the old
  episode id but kept its position and pause, so a later pop-out with no explicit position began the
  new film 600 s in and paused.
- A playlist page that carries a second `<script>` no longer loses its whole episode list: the list was
  read with a greedy pattern that ran on into the next script, so the page failed to parse and no
  episode was left to skip; the object is now decoded from its own opening brace.
- A short Popular Radio request no longer caps the next one: the ranked list was cached at the size that was asked for, so a `limit=1` call left one station cached for fifteen minutes and a following `limit=24` answered with that single row instead of the presets that were already on hand — the pool is now built at least a default page long, and a cached list only answers a request it covers.
- The popped-out window's Next/Previous on a playlist steps its episodes in that window, not in the
  parked in-app frame.

## 1.0.1 — 2026-11-24

Bug fixes after the catalog listing; each has a regression test that fails on 1.0.0.

- A command aimed at another profile no longer reaches this one's film. A mood, an audio request or a
  config push made under a profile with no server of its own is now dropped instead of landing on the
  profile this process serves, so one profile's audio could start here and its `enabled=false` could stop
  this renderer.
- Turning mood colours off no longer stops agent motion. `mood_reactive=false` rewrote every mood
  event to `idle` before publishing it, so an agent turn that started after the page settled could
  never wake the visual; the event now carries the raw activity as `agent_mood` (the displayed mood
  still stays neutral) and the page's agent gate reads it.
- A dashboard `/status` poll no longer recreates a deleted profile. Once the lease watcher stopped the
  server for a profile whose folder was deleted, the next poll (or any `get_port()` retry) re-elected
  itself and mkdir'd the profile back, so Hermes refused it with "Named profile home does not exist";
  election now stays down for a home whose folder was deleted while it was being served.
- A manually chosen preset now reaches the screen. With auto presets off the server saved the selection
  but left `preset` out of the config event the page listens to, and a reload applied the saved name
  before the visualiser existed, so the stage opened on the behaviour's family default; the push and the
  boot both show the chosen preset now.
- Preset crossfades last the time they are configured for. The blend is carried in milliseconds but
  was handed to butterchurn as seconds, so a balanced-profile 1200 ms transition mixed for ~20 minutes
  (with the new preset name already recorded); the page now converts at the renderer boundary, and
  0 ms still switches instantly.
- A muted film stays muted when it is popped out. The Desktop hand-off now carries the mute, so the
  window's player starts silent instead of talking over the radio.
- Capture recovery reaches the page. When system audio comes back after a `capture_lost` (on the same
  backend or a reopened one), the server publishes the capture name, so the canvas and render loop
  return without touching a control; a backend that keeps returning nothing is now probed again
  instead of being skipped for still carrying a real name.
- A reconnecting page re-reads the config: a page opened while Aura was off picks up an enable made
  during the disconnect and resumes drawing instead of staying paused with PCM arriving.
- A restored WebGL context rebuilds the visualizer instead of reusing the dead instance: the old
  programs, buffers and textures are gone after a GPU reset, so the backdrop used to stay black.
- Reduced motion stays on when it is saved in the config. Waiting out the 350 ms boot re-read or
  leaving and returning to the page no longer re-enables full motion (only the OS preference and the
  URL flag were re-read, so the saved choice was dropped), and the strobe presets stay out of rotation.
- "Only while active" no longer fades out a visualiser that is still drawing quiet music. The frame's
  visibility follows the page's own PCM wake floor instead of the server's 0.02 silence line, so a quiet
  capture that the page renders (e.g. a tone at 0.0016 peak) stays on screen; true silence still fades it.
- Dashboard /status now reports Aura on when no config is saved. A missing `aura/config.json`, or one
  holding `{}`, made /status say off while the server ran the defaults (on), so the desktop removed the
  stage without any enable click; a missing or empty file now reads as on, like the server.
- A visual strength of 0 is no longer a black stage. The visualizer canvas keeps a faint floor of
  10%, the Settings "Visual opacity" and status-bar "Visual strength" sliders (and the page's own Opacity
  slider) start at 10%, and a saved 0 is painted at 10%; any real value (0.6, 1.0) is untouched, and the silence fade still
  goes fully dark.
- A deleted Hermes profile stays deleted. The lease watcher no longer re-creates
  `<profile>/aura/` behind the user's back (which made Hermes refuse the profile with "Named profile
  home does not exist"); a server whose profile home is gone now stops instead.

## 1.0.0 — 2026-11-24 (catalog pin 6a87c2f; changes since the 11-11 submission)

- The REVamp card points at REVamp itself: Marketplace opens its own page (with Install in Hermes), the
  terminal line is the catalog install `hermes plugins install revamp`, and Find in Plugins says where to
  install it when it is not installed yet.
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
