# Changelog

## Unreleased — quality review fixes

- **The film frame is built from the live server again.** It was handed the
  film's own URL, so a YouTube link became `https://www.youtube.com/watch/player.html`
  and Aura mode embedded the audio URL instead of the visualiser. The frame is
  `<origin>/player.html?url=…&token=…` (or `<origin>/?token=…&overlay=1`), and it
  re-renders when the server comes up.
- **One owner for the player.** Nothing renders while the film is closed, while
  the OS pop-out owns playback, or before the server answers; pane and page open
  together now produce exactly one player (precedence: pop-out → page → pane), and
  an unmount from a surface that never had it can no longer clear the handle.
- **The URL box has one path.** It is a controlled draft synced from
  `settings.videoUrl`, applied by Enter or the Apply button — no blur handler
  racing the click, no empty draft submitted.
- **Live state is published before side effects**, so a failing window call can no
  longer make the plugin believe the server is down.
- Test fixtures use synthetic YouTube playlist ids rather than real ones.

## Unreleased — review fixes

- **The transport strip lives in the composer slot.** It was a fixed bar appended
  to the app body and parked above the input by scanning its DOM; it is now a
  `COMPOSER_AREAS.underside` contribution, and a click hands the caret back via
  `host.composer.focus(null)`.
- **No focus or key capture.** The document-level `focusin`/`keydown` listeners
  and the saved caret range are gone.
- **The film is an SDK `SandboxedFrame`** inside Aura's own pane, page and pop-out
  window — not a raw iframe on the document body. The glass stylesheet and the
  full-bleed "behind the app" visual went with it: the SDK has no backdrop slot
  yet, so it is requested outside the repo (issue drafts are not
  shipped with the plugin).
- **No private active-session read.** The `hermes_cli.active_sessions` import and
  the `runtime/active_sessions.json` reader are gone; the per-chat intensity
  boost is gone with them, and `session_boost` stays on the wire as a constant
  `1.0`.
- **macOS capture dependency declared** (`sounddevice`, darwin only), and the
  token path now resolves through `config.hermes_home()` so it follows the
  active profile.

## 1.0.0 — in catalog review

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

### After the hackathon submission

The hackathon entry pins commit `90e8b80` ([NousResearch/hermes-agent#154027](https://github.com/NousResearch/hermes-agent/pull/154027), tag `hackathon-submission`). 1.0.0 is the commit the catalog accepts; these changes came after the submission:

- **The server reports the release version.** Its health check said `0.1.0`; it now matches `plugin.yaml`.
- **The version chip tells a release from a development build.** A catalog install of the pinned commit, or a checkout at the release tag, reads `X.Y.Z`; any other build reads `X.Y.Z-dev`. `tools/release_check.py` and the release workflow keep the version, the changelog, the tag and the GitHub release in step.
- **Documentation:** a rebuilt README with a recorded demo and current Hermes Desktop screenshots, and a full docs set (usage, reference, architecture, configuration, troubleshooting, FAQ, development and testing).
- **Project files:** contributing guide, code of conduct, security policy, issue and pull request templates, and CODEOWNERS.
