# Changelog

## Unreleased — the control strip, laid out for a film under your hands

- **The strip reads top to bottom now.** The drag bar, a seek bar across the
  full width of the strip, a thin row with elapsed on the left and time-left over
  the film's length on the right, then one big row: Close (✕) at the far left,
  previous, play/pause, next, volume, CC, and **Frame in Hermes** /
  **Pop out to desktop** together on the right. Every control is a 36px target,
  and the row wraps at narrow widths instead of overflowing. The old ±10 s /
  ±1 min buttons are gone: the seek bar, the wheel and the arrow keys seek
  faster than they did.
- **Close is out of the drag's reach.** It sits at the far left of the bottom
  row, with the drag bar and the whole seek bar between it and the grip, so a
  press that starts on the grip can never land on it.
- **See-through, and solid under your hands.** `videoBarOpacity` still drives
  the strip's translucency (now 0.2–1, default 0.6 — Settings ▸ Controls
  transparency), and the strip goes fully opaque while it is hovered or holds
  the keyboard.
- **Wheel and keyboard, like the volume.** The wheel seeks ±5 s over the seek
  bar and changes the level ±5% over the volume; with the strip focused,
  Left/Right seek ±5 s, Up/Down move the volume ±5%, Space plays or pauses, C
  toggles captions and Escape gives the keyboard back to the chat. A key pressed
  in the chat's own text box is never taken.

## Unreleased — the music outlives the film, and CI runs every desktop suite

- **Closing the film no longer takes the music with it.** The audio channel
  (`web/audio.js`) lives in the one page Aura frames; that page is now kept up
  whenever music or radio has a source, even while the film is closed, and it is
  the visualiser page rather than a dead player. Before this, "stop the film,
  keep the radio" left `playAudioSource` posting into nothing.
- **Radio survives the panel going away.** The Right panel is a video surface, so
  in visualiser mode there is no panel to host the music's page. That page now
  has a seat of its own — an always-registered, zero-size, `opacity: 0`
  SandboxedFrame in the composer's underside slot (`filmOwner() === 'audio'`),
  which renders only while no visible surface owns the film. One frame still,
  never two: a panel, the page or the pop-out takes it back, and the music is
  handed to the new page instead of falling silent.
- **The desktop suites are back, and CI can no longer lose one.**
  `tests/test_listen_desktop.mjs` and `tests/test_fresh_install.mjs` had been
  crashing at import since the SandboxedFrame change (their SDK stubs lacked
  `COMPOSER_AREAS` and `SandboxedFrame`), so nothing ran them; both now import
  and assert through the recorded frames. The desktop CI job runs every
  `tests/*.mjs` file instead of one named file.

## Unreleased — the 346-title shelf

- **The Aura page opens on a real catalogue.** Library now starts with **Picks**
  (the starter sources) and then one horizontally scrolling row per category
  — Deep sea & oceans, Nature & wildlife, Space & astronomy, Earth from above,
  Slow TV, Classic films, Classic cartoons, Anime, Open movies, Science &
  history docs, Ambience — with 346 verified titles in all. Each row carries its
  name and count, each card its title, year and length (poster-less), its
  one-line note on hover/focus, and one click plays it through the same
  `applyVideoSource` path a picked starter takes. One search box filters every
  row at once; rows scroll sideways and shrink on narrow windows instead of
  pushing the page wider.
- **The catalogue is a committed file, served by the server.** `web/catalog.json`
  is generated from the verified rows by `tools/build_catalog.py` and served at
  `GET /api/catalog` (read once, cached); the dashboard mirrors it at
  `GET /catalog`. The page fetches it through `ctx.rest('/catalog')` once per
  mount, and if that fails it still works with Picks and the saved library.
- **`aura_watch action=browse` reads the same catalogue offline.** Optional
  `category` and `query` return up to ten matches (title, year, category, url);
  with neither it lists the categories. Nothing plays until the pick goes
  through `action=play`, exactly like `action=search`.
- **`tools/build_catalog.py` retires the multi-gigabyte masters.** For each
  archive.org `/download/<id>/<file>.mp4` over 2 GB it HEADs the item's smaller
  derivative (`<name>_512kb.mp4`, then `<id>.ia.mp4`) and switches only when the
  answer is `200` with a `video/*` type and a genuinely smaller Content-Length —
  archive.org returns 200 (and the original bytes) for derivative names that do
  not exist, and those are refused.

## Unreleased — subtitles you control

- **A CC button, on every player surface.** The floating control strip, the
  docked pane (**Subtitles**), the Aura page, the **A** menu and Settings ▸
  Plugins ▸ Aura all carry the same switch, and the choice is remembered
  (`videoCaptions`, off by default — before this, YouTube decided on its own).
  The agent can set it too: `aura_control` with `action=captions`,
  `captions=on|off`.
- **The embed only asks for captions when they are on.** `cc_load_policy=1` plus
  `cc_lang_pref` appear in the player URL only then; a live player is switched
  with the documented `loadModule`/`unloadModule` command pair instead of a
  reload, so the film never restarts. Both are re-applied per video, because
  YouTube resets captions on every new video in a playlist.
- **The language list is the video's own.** The player publishes its caption
  tracks (`apiInfoDelivery` → `getOption('captions','tracklist')` shapes); the
  menu offers exactly those, and picks one with
  `setOption('captions','track',{languageCode})`. Automatic means the machine's
  language, then English. Preferred language is remembered
  (`videoCaptionLang`).
- **"No subtitles" is an answer, not a guess.** Ambient uploads publish no
  captions namespace at all, so the button is disabled with *No subtitles for
  this video* instead of pretending. A direct MP4/WebM switches its own
  `textTracks` between `showing` and `hidden`.
- **The popped-out window starts with the same choice** (`captions`/`cc_lang` on
  `/api/window/open`) and reports its own state back, so the app's switch never
  disagrees with the picture.
- **Documented limit:** subtitles burned into the picture cannot be turned off.
  No player API exposes them; the README and USAGE say so plainly.

## Unreleased — the two pop-outs actually work

- **The frame in Hermes is a real frame with its own bar.** A title, a grip and
  its own **Bring back** / **Pop out to desktop** / **close** sit along its top
  edge, so it is obvious how to move it and how to leave it. Dragging the bar
  moves the frame (and only the frame): its position is its own, clamped to the
  window, and remembered across a restart. It used to be contributed as a pane
  with `placement: 'floating'` — a placement the plugin SDK does not have, so
  the host laid it out as an ordinary tile and it had no handle to drag.
- **The frame no longer goes missing for the rest of a session.** A hot reload
  left a stale registration handle behind, so `registerWatchPane` saw "already
  registered" and contributed nothing: Frame in Hermes did nothing at all until
  Hermes was restarted.
- **"Pop out to desktop" opens the window or says why.** The button asks the
  server whether this machine has a browser; only a plain `available:false`
  falls back to the frame inside Hermes, and that is announced. Otherwise the
  server's own reason is shown in a visible note (the pane's stage line, the
  host notification and the settings server line), and the film stays exactly
  where it was — the in-app frame is parked only after the window has answered.
- **The right panel is the film's panel.** It is on screen only in video mode
  with the film open: switching to the Aura visual, or closing the film, takes
  it away on the click, and it comes back on its own when video mode returns.
  The **Right panel** switch now means "show it in video mode".

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


## Unreleased — readable chat text over a film

- **A new Readable group in Settings ▸ Plugins ▸ Aura.** One switch that makes
  the chat legible over a film, plus the three choices behind it: **text size**
  (S/M/L/XL), **text font** (System, Atkinson Hyperlegible, Inter, Mono) and
  **text colour** (White, Warm, High-contrast yellow).
- **It is the theme that changes, not the app.** Every choice maps to a token in
  the host theme contract — size to `typography.baseSize`/`lineHeight`, font to
  `typography.fontSans` (plus a `fontUrl` from `fonts.bunny.net` for the two
  webfonts), colour to `colors.foreground` and `mutedForeground` on both the
  light and dark palettes — and Aura's own contributed theme is re-registered,
  so the host repaints. No stylesheet, selector or style rule ever touches app
  markup (the owner's Nous-review rule).
- **On and off tell the truth.** Turning Readable on requests the Aura theme
  (the readable tokens live in it, so it is the same opt-in), and turning it off
  goes through `restoreTheme()`, which hands back the theme the user was wearing.
  Turning "Use Aura theme" off, or **Restore my theme**, turns Readable off with
  it rather than leaving a switch that lies.
- **Idle no longer reverts the text.** "Keep my theme when idle" used to hand the
  user's theme back whenever no film or visual was showing, undoing Readable
  exactly when the film ends; Readable now keeps the theme while idle.
- A **Hermes chat font** row points at Hermes' own setting (Settings ▸
  Appearance ▸ Chat font), which overrides the chat face alone.
- Ten contract tests cover it: each choice's token mapping, the ordering of the
  four sizes, the CDN rule (only the webfonts get a stylesheet), the measured
  luminance of each ink on the dark palette, on/off restore, the idle case, the
  single in-place theme contribution, and that no host DOM node or style is
  written.


## Unreleased — narrow surfaces, and two named pop-out buttons

- **The quick menu can no longer overflow.** The popover is laid out at a fixed
  288px (`QUICK_MENU_WIDTH`); every row wraps, its label ellipsises, and its
  control may shrink. The old "Open on a screen" button that hung past the right
  edge is gone.
- **Two pop-out buttons with the same words on every surface** (quick menu,
  right panel, Aura page, floating control strip): **Frame in Hermes** (a toggle,
  pressed while the in-app frame holds the film) and **Pop out to desktop**
  (which reads **Bring back** while the desktop window holds it). The right
  panel's ⧉ glyph called a function that did not exist; it now opens the frame,
  and the panel has both buttons.
- **"Skipped episodes"** replaces "Hidden episodes": the row only appears when
  something is skipped, its button reads "Show all N again", and its tooltip is
  "Episodes you hid from your playlists. Aura skips them."
- **The right panel works at 260px.** Five evenly spaced transport buttons that
  flex instead of overlapping, a volume slider contained by the card, the five
  see-through choices (Auto/25/50/75/100) wrapping onto two lines, and film
  cards stacked with the title under a card-wide thumbnail, clamped to two lines.
  Every child is `border-box`, so a 1px border cannot cause a horizontal scroll.


## Unreleased — reaction strength and opacity that mean what they say

- **Reaction strength now draws what the slider says.** The page used to remap the setting
  (`gain = 0.2 + 1.8 × intensity`), so a 25% setting drew 65% and a 0% setting still drew a
  fifth of the range: the slider could not be turned off and never matched the picture. The
  gain is now the setting itself (`0` = no audio reaction, `0.25` = a quarter), with the
  auto-gain still lifting a quiet capture and reduced motion still scaling it down.
- **Opacity is applied once, not twice.** The visualizer page dims its own canvas and
  compensates its scrim for it (CONTRACT.md §9.2), and the desktop half dimmed the whole frame
  on top of that — so a 25% setting drew 6% and the page's legible chrome dimmed with it. The
  frame now carries only the fade factor; a film frame still carries the video's adaptive
  transparency.
- **New installs start at 25% reaction strength and 25% opacity** (was 50% and 35%). First-run
  defaults only: a saved `config.json` or plugin storage keeps its own values.

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
