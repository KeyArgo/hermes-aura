# Spikes S1–S5 — results as measured on 2026-11-04 (Linux workstation, PipeWire)

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
