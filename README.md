<p align="center">
  <img src="assets/hero.svg" alt="Aura — a film behind your work, and an app that breathes with your audio" width="100%">
</p>

<h1 align="center">Aura</h1>

<p align="center"><i>A film behind your work, and an app that breathes with your audio.</i></p>

<p align="center">
  <a href="https://github.com/KeyArgo/hermes-aura/actions/workflows/tests.yml"><img alt="CI: tests" src="https://github.com/KeyArgo/hermes-aura/actions/workflows/tests.yml/badge.svg?branch=main"></a>
  <a href="TESTING.md"><img alt="621 tests passing" src="https://img.shields.io/badge/tests-621%20passing-2ea44f?style=flat-square"></a>
  <a href="https://github.com/NousResearch/hermes-agent/pull/154027"><img alt="Hermes plugin catalog: in review" src="https://img.shields.io/badge/plugin%20catalog-in%20review-f59e0b?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-2f6bff?style=flat-square"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img alt="Hermes Agent 0.22.5 or newer" src="https://img.shields.io/badge/Hermes%20Agent-%E2%89%A5%200.22.5-7c3aed?style=flat-square"></a>
  <img alt="Linux, PipeWire or PulseAudio" src="https://img.shields.io/badge/platform-linux%20%C2%B7%20pipewire%2Fpulseaudio-555?style=flat-square">
  <img alt="Python 3.11 or newer" src="https://img.shields.io/badge/python-3.11%2B-3776ab?style=flat-square">
  <img alt="Node 18 or newer" src="https://img.shields.io/badge/node-18%2B-5fa04e?style=flat-square">
  <a href="https://github.com/KeyArgo/hermes-aura/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KeyArgo/hermes-aura?style=flat-square&color=f5b301"></a>
</p>

<p align="center">
  <img alt="140 MilkDrop presets" src="https://img.shields.io/badge/milkdrop%20presets-140-ec4899?style=flat-square">
  <img alt="no account, no uploads, no recording" src="https://img.shields.io/badge/privacy-no%20account%20%C2%B7%20no%20uploads-0d9488?style=flat-square">
  <img alt="plugin surface: desktop pane, page, status bar, tools" src="https://img.shields.io/badge/surfaces-pane%20%C2%B7%20page%20%C2%B7%20window%20%C2%B7%20tray-f59e0b?style=flat-square">
  <img alt="capture: system loopback, never the microphone" src="https://img.shields.io/badge/capture-system%20loopback%2C%20not%20mic-e11d48?style=flat-square">
</p>

<p align="center">
  <img src="docs/media/aura-demo.gif" alt="Aura in Hermes Desktop: a documentary plays in the docked film pane, then the visualiser fills the app behind the chat" width="100%">
</p>

<p align="center"><sub><b>Aura inside Hermes Desktop</b>: the film pane beside your work, then the same audio driving the visualiser behind the chat.
<a href="https://x.com/MHArgonaut/status/2120634853146435961">Watch the full 50-second demo ▶</a></sub></p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#testing">Testing</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## What it is

Aura turns Hermes Desktop into a room you can live in. Put any film, lecture or
playlist in the right-hand pane and keep working; switch the film off and the
same audio drives a MilkDrop-compatible visualiser behind the interface. It
listens to what the machine is already playing — system loopback, never the
microphone — and nothing leaves the computer: no account, no uploads, no
recording.

> Aura is not a music-service integration. It needs no Spotify, no YouTube Music
> and no account of any kind. If the speakers are making a sound, Aura can see it.

## Why it's different

- **One audio path, two jobs.** The soundtrack of the film you watch is the same
  signal that paints the room. There is no second player and no second capture.
- **A player with three surfaces, not three players.** The film exists in the
  docked pane, the Aura page or its own OS window — exactly one at a time, with
  the position kept per film.
- **The agent is a remote, not a script.** Pause, seek, next episode, pop out,
  find something to watch, find a radio station: all through three tools that
  return JSON and never autoplay.
- **Private by construction.** Loopback only, analysed in memory, no recording,
  no telemetry, a local server bound to `127.0.0.1` with a per-launch token.
- **Linux-first and honest about it.** PipeWire and PulseAudio are tested;
  Windows is implemented but unproven; macOS needs a virtual audio device.

---

## Features

### Watch while you work

- **A docked theatre pane** on the right: 16:9 stage, scrubber, transport,
  volume, and a poster list of your sources. Closing it leaves only the
  status-bar menu.
- **YouTube videos, YouTube playlists, direct MP4/WebM.** Any public or unlisted
  playlist link works.
- **Per-film resume.** Every film remembers where you stopped, keyed by URL, so
  switching sources all day never restarts anything. A film that reaches the end
  is not remembered as being at its last second.
- **Playlist episodes.** Next/previous move through the episodes of a playlist,
  and fall back to your saved sources when the current source is a single video.
- **Auto-skip.** A playlist item that forbids embedding (or has been deleted)
  would otherwise break the whole list, so Aura resolves the playlist
  server-side and moves to the next playable episode.
- **Manage a playlist where it lives.** `☰` hands the list to the pop-out
  window — real Chromium on its own profile — so YouTube's own page opens and
  adding, removing and reordering work with your own session. No API scope, no
  OAuth review, no second account.
- **Free placement.** The floating watch window drags anywhere and remembers its
  spot; 320 / 480 / 640 wide. Its control strip is two rows — the film's title,
  scrubber, clock, volume and window buttons above a centred transport row —
  stays inside the viewport, and dims when idle instead of vanishing.
- **An Aura page in the sidebar — the whole product in one place.** The same
  film in a big 16:9 frame with the transport, volume and source picker, a
  **Library** of poster cards (add, rename, remove, hide starters, clear
  recents), the playlist how-to, and every setting Aura has underneath. Dark
  glass over a violet-to-ember gradient, scoped to `#aura-page`. It is the
  *same* player — the film moves into the page while it is open and goes back
  when you leave. **Pop out** floats it in a watch window you can drag anywhere;
  **Bring back** returns it to the page.
- **One library, two pickers.** The source dropdowns in the A menu and in
  Settings list everything — saved playlists, your films, the starter pack and
  recents — grouped under `Playlists`, `Your films`, `Starters` and `Recent`. A
  small **Edit sources…** link opens the Aura page, where editing lives.
- **A film owns the screen.** While Backdrop is **Video player**, Style,
  Intensity, the Aura transparency and Gentle motion are greyed out (they only
  describe the Aura visual), and Show is forced to Always in effect: a playing
  film is never faded out by “Only while active”. The video's own transparency
  stays live. Your stored Show choice is not overwritten — switch back to the
  Aura visual and it returns.
- **REVamp, next door.** Aura has no music library of its own.
  [REVamp](https://github.com/KeyArgo/hermes-revamp) is a Winamp-style player for
  Hermes, and Aura's visuals react to whatever it plays — one card on the page,
  one line in Settings.

### Watch the machine

- A MilkDrop-compatible WebGL visualiser driven by system audio — level, bands,
  silence gating.
- **140 curated presets** from the Butterchurn packs Aura ships.
- Backdrop opacity that follows the room: dim when quiet, brighter with music,
  with manual presets.
- An optional accent that follows the audio, and agent moods: thinking, running
  tools, waiting for approval, erroring, streaming, finished — each restores
  itself, nothing latches.

### Listen to anything

Aura listens to more than a film's soundtrack: internet radio, direct audio
files and streams play on their own channel, beside the video and independent
of it.

- **Radio.** A curated starter list (SomaFM, NTS, KEXP, FIP, Radio Paradise, BBC
  World Service and more), a search across the
  [Radio Browser](https://www.radio-browser.info/) directory by name or genre
  tag, and favourites that persist between sessions. `.pls` and `.m3u`
  playlists are resolved server-side, so a playlist link behaves like a station.
- **Direct audio.** Any public `http(s)` URL to mp3, ogg/opus, aac/m4a, flac or
  wav.
- **Music on, video muted.** The audio channel has its own volume and mute, so a
  film can run silently while music plays — watch the lecture, listen to the
  radio. The muted state is remembered with the film.
- **Ask the agent.** The **`aura_listen`** tool searches radio, shows numbered
  choices, waits for your pick, then plays it: *“find me some jazz radio”* → a
  numbered list → *“the second one”*. It can also stop the audio, set its
  volume, or mute/unmute the video without touching the music.
- **Visuals follow it.** Nothing new feeds the visualiser: Aura already reacts
  to system audio, so music from Aura's own channel (or any other app) drives the
  same visuals.

**Aura is a media player, not a Winamp.** If you want a Winamp-style player with
your local library, audiobooks, skins and a 90s attitude, install **REVamp** — it
is the same author's other plugin, and Aura's visuals react to whatever it plays.

### Control it by talking to Hermes

Because the server is the remote, anything in the window can still be driven
from the chat — no alt-tab, no reaching for the mouse:

- “pause” / “resume” / “next episode” / “go back an episode”
- “jump to 40 minutes” (seek)
- “put it on my other screen” / “pop the film out” / “bring it back into Hermes”

The agent calls `aura_control` with
`action=pause|resume|next|prev|seek|popout|popin`, and `action=status` answers
“what is playing?” with the title, position, duration and whether the window is
open. Commands go through a small server-side queue
(`/api/player/command`), which the desktop window polls about three times a
second and applies to the same player code the in-app transport uses.

### Ask Hermes for something to watch

You do not need a link. Say what you are in the mood for:

> **You:** I want to watch a documentary about octopuses.
> **Hermes:** Here are a few — say the number:
> 1. Secrets of the Octopus: the Ocean's Masterminds · Nat Geo Animals · 2:03:39 · youtube.com/watch?v=3GB-7qwwIp0
> 2. Full octopus documentaries · Timely Documentaries · 8 videos · youtube.com/playlist?list=PL…
> 3. Masterminds: Secrets of the Octopus (Full Episode) · National Geographic · 42:32 · youtube.com/watch?v=ah8U0-fV6k8
> **You:** 2
> **Hermes:** Playing “Full octopus documentaries” in Aura.

The agent calls **`aura_watch`** with `action=search`, shows the numbered
options (title, channel, length and link) and stops. Nothing plays until you
pick; then it calls `action=play`, which puts the choice on the same player
queue the transport buttons use — so it starts in the docked pane, the Aura page
or the popped-out window, whichever is showing the film. `action=now` answers
“what is playing?” without opening anything.

Search is keyless: it reads YouTube's public results page, caches the answer for
five minutes, and returns nothing rather than an error when YouTube is
unreachable (the agent then says so, and can fall back to its own web search with
a direct link). `action=play` accepts YouTube watch / `youtu.be` / shorts / embed
/ playlist links and direct `.mp4`, `.webm`, `.m3u8` and `.mov` files. The
dashboard also exposes the same search as
`GET /api/plugins/aura/search?q=…&limit=…`.

### The plugin surface

- Status-bar **A** menu: play/pause, seek, volume, source picker, watch window,
  Aura panel.
- A sidebar **Aura** page: the film, the transport and the full setup in one
  place.
- A settings page with every control, including dropdown lists that stay
  readable on dark themes.
- The **`aura_control`** tool, so the agent itself can set the room; the
  **`aura_listen`** tool for radio search and the audio channel; the
  **`aura_watch`** tool to find something to watch and start the choice you pick.
- Hooks: session start/end, `pre`/`post_tool_call`, approval request/response,
  `api_request_error`, stream start/end, subagent start/stop.

### Screenshots

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/desktop-film-pane.png" alt="The film pane docked in Hermes Desktop playing a documentary"><br><sub><b>The film pane</b><br>A film docked beside your work in Hermes Desktop.</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/desktop-film-shelf.png" alt="The Aura page with the film shelf and a YouTube link field"><br><sub><b>The shelf</b><br>Pick a film, or paste any YouTube link or playlist.</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/desktop-visualiser-behind-chat.png" alt="The visualiser filling Hermes Desktop behind a chat"><br><sub><b>Behind the chat</b><br>The whole app breathes with what is playing.</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/desktop-visualiser-full.png" alt="The Aura visualiser page reacting to the agent's state"><br><sub><b>It follows the agent</b><br>Thinking, waiting for approval, streaming an answer.</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-skylight.png" alt="Skylight preset"><br><sub><b>Eo.S. + Zylot — skylight</b><br>Stained-glass blooms over a dark room.</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-tokamak-witchery.png" alt="Tokamak witchery preset"><br><sub><b>Flexi, fishbrain, Geiss + Martin — tokamak witchery</b><br>Particles drift with the low end.</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-spiral-artifact.png" alt="Spiral artifact preset"><br><sub><b>Geiss — Spiral Artifact</b><br>A rigid, geometric reaction.</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-infused-spiral.png" alt="Infused with the spiral preset"><br><sub><b>Flexi — infused with the spiral</b><br>Organic ribbons on the beat.</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-pogo-cubes.png" alt="Pogo cubes preset"><br><sub><b>Flexi + Geiss — pogo-cubes on tokamak matter</b><br>Cells that breathe with the mix.</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/visualiser-page-chrome.png" alt="Visualiser page with controls"><br><sub><b>The page at 1440 × 900</b><br>Reaction strength, opacity, behaviour and motion.</sub></td>
  </tr>
</table>

<sub>All six are real renders captured 2026-11-11 from the shipped Butterchurn
build and preset set, driven through an analyser by a synthetic signal. The
visualiser is the part that renders identically headless; the Hermes pane and
page chrome are drawn by the host.</sub>

---

## Install

```bash
hermes plugins install KeyArgo/hermes-aura --yes-deps --enable
```

Then turn it on in **Settings ▸ Plugins ▸ Aura**. The Aura pane appears on the
right; closing it leaves only the status-bar menu. Nothing is captured until
Aura is enabled.

**Requirements:** Hermes Agent 0.22.5 or newer. Linux with PipeWire or
PulseAudio for audio capture. Chrome or Chromium for the pop-out window.
Python 3.11+ and Node 18+ for development. Windows capture uses the
`soundcard`/`numpy` dependencies declared in `plugin.yaml` and installs
automatically there; macOS needs a virtual audio device.

### Quick start

1. Install and enable Aura (above).
2. Open the status-bar **A** menu and pick a film, or paste a YouTube video or
   playlist URL.
3. Work. The film plays in the right-hand pane.
4. Switch the film off and the same audio paints the visualiser behind the
   interface.
5. Ask Hermes for something: *“find me a documentary about octopuses”* or
   *“find me some jazz radio”*.

### Adding a YouTube playlist

1. Open the playlist on YouTube.
2. Press **Share**, then **Copy link** — it looks like
   `https://youtube.com/playlist?list=PL…`.
3. On the Aura page, paste it into the Library box, give it a name if you like,
   and press **Add**.

Public and unlisted playlists play here. Private playlists cannot be embedded
and are not supported.

### Upgrading, uninstalling and your data

- **Upgrade:** reinstall with the command above. Settings and sources are kept
  in `~/.hermes/aura/`.
- **Uninstall:** remove the plugin through Hermes' plugin list. The local
  server exits with the plugin process.
- **Delete your data:** remove `~/.hermes/aura/` while Aura is off. That folder
  holds `config.json`, the token, `server.lock`, `lease.json` and
  `radio_favorites.json`. Nothing is written anywhere else; audio samples never
  touch disk.

---

## How it works

```mermaid
flowchart LR
  out["System output<br/>PipeWire / PulseAudio monitor"] --> cap["Capture thread<br/>pw-record / parec"]
  cap --> fft["aura_core.analysis<br/>RMS, bands, onset, silence"]
  fft --> ws["aura_core.server<br/>WebSocket /api/stream"]
  ws --> viz["web/aura.js<br/>Butterchurn WebGL"]
  viz --> screen["Backdrop, pane or pop-out window"]

  agent["Hermes Agent"] --> hooks["__init__.py hooks<br/>mood transitions"]
  hooks --> mood["aura_core.mood<br/>MoodMachine"]
  mood --> server["aura_core.server<br/>/api/mood, /api/state"]
  server --> desktop["desktop/plugin.js<br/>Hermes Desktop half"]
  desktop --> viz
  desktop --> api["dashboard/plugin_api.py<br/>/api/plugins/aura/*"]
  api --> server

  tools["aura_control, aura_listen, aura_watch"] --> api
```

`aura_core/capture/` probes PipeWire, PulseAudio, WASAPI and macOS in order and
starts a monitor recorder. `aura_core/analysis.py` reduces each 1024-sample
frame to RMS level, eight bands, onset, centroid, flatness and a silence flag.
`aura_core/server.py` streams raw PCM and feature events over one token-gated
WebSocket; `web/aura.js` feeds the PCM to Butterchurn and uses the features for
level, bands, silence gating and moods. `desktop/plugin.js` owns the Hermes
surfaces and talks to the server only through `dashboard/plugin_api.py`, so it
never guesses a port. `__init__.py` maps eleven agent hooks onto
`aura_core/mood.MoodMachine` and registers the three tools.

The film has one player and three surfaces. The diagram below is the shape of
that rule; the film moves, and the surface that loses it does not keep a copy.

<p align="center"><img src="assets/three-surfaces.svg" alt="The docked pane, the Aura page, and the pop-out window" width="100%"></p>

### Pop out to its own window

Click **Pop out** and the film leaves the Hermes window: a real OS window
(Chrome/Chromium app mode) that you can drag to another monitor or full-screen.
It opens at the exact second the in-app player had reached, and the in-app one
pauses so two copies never play with sound. **Pop in** closes it again.

The pop-out needs Chrome or Chromium. If none is installed Aura says so plainly;
set `AURA_DESKTOP_BROWSER=/path/to/chrome` to point it at one. The window uses
its own browser profile, so it never touches your normal browsing session. If
the Aura server restarts (or the app quits), the window is closed with it — a
stale window could play audio nothing can control.

### The audio path

<p align="center"><img src="assets/audio-path.svg" alt="Audio path: system loopback, capture thread, /api/stream, Butterchurn, the screen" width="100%"></p>

The capture thread reads the default sink's monitor, not a microphone. When the
last Aura surface closes, capture drops to silence after 30 seconds and reopens
when a surface returns, unless `listen_background` is set. The detailed file map
is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Documentation

| Document | What it answers |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Every feature as a walkthrough, with screenshots. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, files on disk, key files. |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Every tool, hook, route and config key. |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every setting and environment variable. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Real failure modes and fixes. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Repo layout, local setup, CI. |
| [docs/FAQ.md](docs/FAQ.md) | Short answers to common questions. |
| [docs/README.md](docs/README.md) | The documentation index. |
| [TESTING.md](TESTING.md) | Commands, suite counts, what CI runs. |
| [VERIFY.md](VERIFY.md) | What was verified on a clean checkout, and what was not. |
| [CONTRACT.md](CONTRACT.md) | The wire contract between the server, page, desktop half and hooks. |
| [LIMITS.md](LIMITS.md) | Known limits, stated plainly. |
| [SPIKES.md](SPIKES.md) | Measurements that shaped the design. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | How to send a change and how we work together. |
| [SECURITY.md](SECURITY.md) | What Aura touches and how to report a vulnerability. |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Vendored libraries and preset attribution. |

---

## Privacy & security

**What Aura stores.** Settings, a per-launch token, a server lease/lock and radio
favourites in `~/.hermes/aura/` (mode `0600`). Nothing else.

**Network calls.** The local server binds `127.0.0.1` and requires a per-launch
token. Films are fetched from the URLs you choose. Keyless YouTube search reads
YouTube's public results page and caches it for five minutes. Radio search
queries [Radio Browser](https://www.radio-browser.info/); `.pls`/`.m3u`
resolution and the audio stream proxy go through the local server so the browser
never follows an unchecked redirect. No account, no telemetry, no self-updater.

**Background processes.** A capture process (`pw-record` or `parec`) while Aura
is listening, the local HTTP server, and — only when you ask — a Chromium app
window on its own profile. Capture stops after 30 seconds with no Aura surface,
and immediately when Aura is turned off or the motion mode does not use audio.

**Shell commands.** Aura starts `pw-record`/`parec` for capture, `pactl` or
`pw-dump` to find the monitor, and the chosen Chromium binary for the pop-out.
It does not run a shell, and it does not touch host `html`/`body` styles.

**Host safety.** The pane is a Hermes `PANES_AREA` contribution — Hermes lays it
out; no fixed positioning, no z-index, no `body` padding. The backdrop is one
click-through iframe at negative z-index plus a single `#aura-glass` stylesheet,
mounted only while a visual is showing. Host root styles are never written; the
accent override is the SDK's sanctioned mechanism. Switching the visual off,
turning Aura off, **Restore my theme** and plugin disposal remove every effect
Aura applied and restore the theme that was there before.

Report a vulnerability privately via GitHub's **Security → Report a
vulnerability**; see [SECURITY.md](SECURITY.md). Do not open a public issue.

---

## Testing

```bash
python3 -m pytest tests -q -p no:cacheprovider --ignore=tests/e2e --ignore=tests/integration
node --test tests/test_desktop_plugin.mjs
```

| Suite | Result at this commit |
|---|---|
| Python (capture, analysis, server, hooks, tools, radio, search) | **489 passed** |
| Desktop contract (menu, pane, transport, resume, mode gating) | **132 passed, 0 failed** |
| **Total** | **621 passed** |

The end-to-end visualiser tests drive a real headless Chrome and measure the
canvas. They skip themselves when the machine is too loaded to sample reliably
rather than reporting a false failure. Full commands, the CI job layout and what
is not covered are in [TESTING.md](TESTING.md) and [VERIFY.md](VERIFY.md).

---

## Limits

| Area | Status |
|---|---|
| Audio capture | **Linux** (PipeWire / PulseAudio monitor) — tested. Windows (WASAPI) is implemented but unproven on real hardware; macOS needs a virtual audio device. Treat Aura as Linux-first. |
| YouTube | Embeds play only when the uploader allows it. Aura detects the refusal and skips the episode; it cannot play a video that forbids embedding. |
| Netflix, Disney+, most streaming services | **Not possible** — their players refuse to be framed (DRM + `X-Frame-Options`). Aura offers “open in browser” instead. |
| Plex | Not built. A direct stream URL works; the server integration is not written. |
| Playlists | Resolved by reading the public playlist page — no API key, no OAuth. Public and unlisted lists only; private/account lists need Google sign-in and are unsupported. |
| Privacy | Audio is analysed in memory and never written or sent. No account, no telemetry. |

[LIMITS.md](LIMITS.md) has the two implementation limits worth knowing
(POSIX-only single-server election, host-styling layout risk).

Pre-release. [SPIKES.md](SPIKES.md) records what was actually measured;
[CONTRACT.md](CONTRACT.md) is the wire contract between the capture server, the
page, the desktop half and the agent hooks.

## Contributing

Bug reports, small focused fixes and new ideas are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first; it covers the issue templates, the
checks to run, and the rule that a change touching privacy, network calls or
capabilities is reviewed first. Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

- **Butterchurn** (MIT) by Jordan Berg and contributors — the MilkDrop-compatible
  WebGL renderer, used unmodified.
- **butterchurn-presets** (MIT) — the preset packs; the curated subset Aura
  ships keeps each preset author's name in its key. Individual credits are in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **REVamp** (MIT, same author) — the internet-radio layer in
  `aura_core/radio.py` is adapted from it, with a credit comment in the file.
- **Radio Browser** — the open community station directory.
- “MilkDrop” is referenced only in prose; Aura is not MilkDrop and is not
  affiliated with Winamp.

<p align="center">Built by <a href="https://github.com/KeyArgo">KeyArgo</a> · InovinLabs</p>
