# FAQ

One line: short answers to the questions the README raises.

Applies to Aura 1.0.0 · revised 2026-11-11

**Is Aura a music player?**
No. It plays films and playlists in a pane, and it reacts to whatever the
machine is already playing. It has no music library of its own. REVamp is the
same author's Winamp-style player, and Aura's visuals react to it.

**Does it listen to my microphone?**
Never. Capture is the system output loopback (PipeWire/PulseAudio monitor on
Linux, WASAPI loopback on Windows). Samples are analysed in memory and
discarded; nothing is recorded, written or uploaded.

**Do I need Spotify, YouTube Music or an account?**
No account of any kind. YouTube links and public/unlisted playlists work
without an API key. Private playlists need Google sign-in and are unsupported.

**Can it play Netflix or Disney+?**
No. Their players refuse to be framed (DRM and `X-Frame-Options`). Aura offers
“open in browser” instead.

**Why did the visual stop when I walked away?**
Capture stops after 30 seconds with no connected Aura surface, to save roughly
4% of one core. Open a surface and it reopens. Set `listen_background` to keep
it running.

**Does it work on Windows or macOS?**
Linux is tested and supported first. Windows capture is implemented through
WASAPI (`soundcard`, installed automatically on Windows) but is unproven on
real hardware. macOS needs a virtual audio device. See [LIMITS.md](../LIMITS.md).

**Why does the pop-out need Chrome?**
Hermes Desktop plugins cannot open OS windows. Aura launches a normal Chromium
app window on its own profile, so the film can go full-screen on another
monitor. Set `AURA_DESKTOP_BROWSER` if it cannot find one.

**Does the agent autoplay things?**
No. `aura_watch` search and `aura_listen` search return numbered choices and
wait. Only the user's pick reaches `play`.

**Where is my data?**
Settings, token, lease, lock and radio favourites under `~/.hermes/aura/`.
Delete that folder to remove everything. See
[CONFIGURATION.md](CONFIGURATION.md).

**Why is the film greyed out of some settings?**
While **Backdrop** is **Video player**, settings that only describe the Aura
visual are disabled, and Show is forced to Always in effect so a playing film
is never faded out. Your stored Show choice returns when you switch back.

**How many presets are there?**
140 in the curated catalogue (`web/presets.json`), from the Butterchurn preset
packs Aura ships. “MilkDrop-compatible” describes the preset format, not
MilkDrop itself.

**How do I report a bug or a security problem?**
Bugs through the GitHub issue templates. Security problems privately through
GitHub's **Security → Report a vulnerability**; see [SECURITY.md](../SECURITY.md).

Back to [docs/README.md](README.md).
