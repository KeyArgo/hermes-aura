# Changelog

## Unreleased

**Review fixes**

- No host-DOM access: no composer scan, no document-level focus or key capture, no stylesheet over app markup.
- The transport strip is a composer `underside` contribution, not a bar appended to the app body; a click returns the caret through `host.composer.focus(null)`.
- The film is an SDK `SandboxedFrame` inside Aura's own pane, page and pop-out window.
- No private session read: the per-chat boost is gone and `session_boost` stays `1.0`.

**New**

- A 346-title shelf in 11 categories on the Aura page, browsable offline and by the agent (`aura_watch action=browse`).
- Quality control: an archive.org item's real files, switched in place at the same second, with a remembered auto/smallest/largest rule. YouTube reports "Auto (YouTube decides)" and is never forced.
- Captions on every player surface, with the language list the video publishes (`aura_control action=captions`).
- 52 starter films (was 8), each label carrying its length.
- `aura_watch` saves, removes and lists the Aura library.
- Readable chat text over a film: size, font and colour, through the host theme contract.
- One-click Play a film, a Now playing block on the page, and a `Watching <title>` status-bar label.
- Control strip rebuilt: seek bar across the top, wheel and keyboard control, see-through that goes solid under the pointer, and a position of its own (`videoBarX`/`videoBarY`).
- Frame in Hermes and Pop out to desktop, worded the same on every surface.
- The sidebar row is optional; the status-bar menu carries Open Aura page.

**Fixed**

- A film plays with Aura switched off, and the music outlives both the film and the panel.
- A film that never loads says so and offers Try again or Pick another.
- Reaction strength and opacity are applied once and match the slider; a new install starts at 25% and 25%.
- The Right panel is a video-mode surface; narrow surfaces wrap instead of overflowing.
- Pop out opens the window or shows the server's own reason; the frame drags, keeps its position and survives a hot reload.

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
