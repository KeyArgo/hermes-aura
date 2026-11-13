# Changelog

## Unreleased — Hermes can edit your own list

- **`aura_watch` can save, remove and list the owner's Aura library** (the
  Playlists and Your films groups in the source picker — never a YouTube
  account's playlists). `action=save` takes a url (or none, meaning "what is
  playing now") plus an optional label that defaults to the playing title; a
  `/playlist` link is saved as a playlist and anything else as a film, the same
  url is never saved twice, and the same url rules as `action=play` apply.
  `action=remove` takes a url or a title (exact or unique, ignoring case) and an
  ambiguous title returns the matches without changing anything. `action=list`
  answers "what's on my list?" with label, url and kind.
- **The desktop reports its library with the player report** (`library` on
  `/api/player/report`, kept by the server on `/api/player`), so `action=list`
  and `action=remove` read the owner's real list; before the first report they
  say "not reported yet" instead of guessing.
- **Two new player-queue commands, `save` and `remove`.** The desktop applies
  them with the same helpers its own Add and Remove buttons use, so the page
  updates live and shows a short note ("Saved to your Aura library"). The
  library poll keeps its own cursor, so a save still lands while the OS window
  owns playback.

## Unreleased — the control strip is the user's

- **Dragging the strip moves the strip.** The ⠿ grip (and any empty part of the
  strip) drags the controls to where you want them; it no longer changes
  `videoWindow` or any other mode. The ⧉ pop-out button is the only thing that
  pops the film out.
- **The strip never jumps.** Placement no longer depends on the app's composer:
  the strip sits at the point you last dropped it (`videoBarX` / `videoBarY`),
  defaults to bottom-left with a 16px margin clear of the status bar, is clamped
  into the window on resize, and does not move when a panel with text inputs
  appears. **Double-click the grip** to reset it.
- The composer-measuring helper is gone for good; a regression test fails if any
  code reads the app's composer again.

## Unreleased — a starter pack worth leaving on

- **24 more starter films, chosen for the backdrop.** `STARTER_SOURCES` goes
  from 8 to 32 entries: BBC Earth's ten-hour oceanscapes, eight hours of BBC
  Earth Science, NASA+ and NASA Goddard films, Seán Doran's real-time ISS
  remaster, two Monterey Bay Aquarium tanks, three cab rides, two city walks,
  silent drone aerials, rain and fireplace beds, Blender's open movies and two
  public-domain features served as direct mp4 from the Internet Archive. Every
  entry carries a one-line note on who uploaded it and why framing it is
  allowed; the YouTube ones were checked through oEmbed (200) and the direct
  files through `HEAD` (200, `video/mp4`).
- **Labels say how long the thing is** (`Open Ocean (10 h) · oceanscape`), since
  a 12-hour single take and a 10-minute short are different products.
- A new contract test parses the catalogue out of the source and asserts the
  pack grew, that no URL or label repeats, and that every entry is a frameable
  YouTube watch link or a direct media file. The two tests that hardcoded
  "8 starters" now read the catalogue instead (`PANEL_SCORE_MAX` still caps the
  A-menu card list at 12).

## Unreleased — readable status bar and a named film

- **The status-bar item is readable.** The "A" trigger was drawn in the faint
  tertiary text token and a 600-weight label. It is now weight 700 in the
  theme's primary text colour when Aura is off and the accent when it is on, so
  it reads in light and dark themes; only Aura's own contribution is styled.
- **The status bar says what is playing.** A `Watching <title>` label sits
  beside the A (truncated with the full title on hover), in the theme's primary
  text colour, and never shows the URL.
- **The Aura page names the film.** A **Now playing** block above the big player
  shows the title in large type and the channel when one is known. The title
  comes from the player's own `getVideoData()` through the existing backdrop
  postMessage bridge, or from the title already stored for the source, and it
  follows a playlist moving to the next episode. A source change clears the
  previous film's title immediately. No URL is sent to any new service.
- `web/player.html` forwards the channel (`author`) and names a direct file from
  its own file name.

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
