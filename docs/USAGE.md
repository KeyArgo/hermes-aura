# Usage

One line: a walkthrough of every user-facing part of Aura, from the first film to radio and the agent tools.

Applies to Aura 1.0.0 · revised 2026-11-13

## Turn it on

Install the plugin, then enable it in **Settings ▸ Plugins ▸ Aura**. Nothing is
captured until Aura is enabled. The Aura pane appears on the right; closing it
leaves only the status-bar menu.

![The visualiser page with the skylight preset and its controls](screenshots/visualiser-page-chrome.png)

*The visualiser page with the skylight preset. Reaction strength, opacity,
behaviour profile and motion source are the real controls at the bottom.*

## Play a film while you work

1. Open the status-bar **A** menu and choose a saved source, or paste a URL.
   The status bar names what is playing (**Watching …**) beside the A, in bold
   full-contrast text — accent-coloured while Aura is on, the theme's own text
   colour while it is off.
2. The film opens in the docked theatre pane on the right: a 16:9 stage with a
   scrubber, transport, volume and a poster list of your sources.
3. Close the pane and the film keeps playing; the status-bar menu brings it back.

Accepted sources are YouTube videos, YouTube playlists, and direct MP4/WebM
files. A film remembers where you stopped, keyed by URL, so switching sources
never restarts it. A film that reaches the end is not remembered at its last
second.

## Subtitles (CC)

Aura does not set caption options for you, and YouTube decides on its own
otherwise. The **CC** button turns them on and off, and the choice is
remembered for every film after it.

- **Where it is.** The floating control strip, the docked pane under the
  picture (**Subtitles**), the Aura page beside the transport, the **A** menu
  (**Subtitles**), and Settings ▸ Plugins ▸ Aura (**Subtitles**). Settings grows
  the language list as well.
- **What it costs when off.** Nothing: with CC off the embed is not asked for
  captions at all, and a running player is told to unload its captions module.
- **Languages.** When a video has more than one caption track, the menu offers
  the ones it actually has (read from the player itself, not from a list Aura
  ships). **Automatic** means the machine's own language, then English. The
  list changes with the video because YouTube publishes it per video.
- **Every new episode.** YouTube forgets captions per video, so Aura re-applies
  the choice on each new video in a playlist.
- **No subtitles.** When the player reports no caption track for the video, the
  CC button is greyed out and its tooltip reads *No subtitles for this video* —
  ambient ocean and cab-ride uploads are like this.
- **Direct files.** An MP4/WebM's own text tracks are switched between showing
  and hidden; a file with no track behaves like a video with no subtitles.
- **Burned-in subtitles cannot be turned off.** If the words are painted into
  the picture (many film uploads are), no player API can remove them and the CC
  button will not change anything. That is the upload's choice, not a bug.

By voice: *“turn the subtitles on”* → the agent calls `aura_control` with
`action=captions`, `captions=on` (or `off`), and the same switch is applied.

## Quality

Aura offers the versions a film really has, and says so plainly when a source
offers none.

- **Where it is.** The **A** menu (**Quality**, in the film section) and the
  Aura page / Settings ▸ Plugins ▸ Aura (**Quality**, under the film's
  settings). Not on the floating control strip: that strip is the transport.
- **archive.org films.** The item's own files, each with the resolution, size
  and format the archive reports — e.g. `640×480 · 393 MB · h.264`,
  `400×300 · 290 MB · Ogg Video`, `320×240 · 289 MB · 512Kb MPEG4`. The list
  comes from the item's metadata, fetched by Aura's local server (short timeout,
  cached per item) rather than by the desktop. Files a browser cannot play
  (`.avi`, `.gif`, posters, the archive's metadata files) are not offered.
- **Switching keeps your place.** Choosing another file swaps the source in the
  player at the same second and keeps playing; the bookmark moves with it, so a
  reload resumes there too.
- **New films: Auto / Smallest / Largest.** The second, smaller control is the
  rule for the *next* archive.org film: `Auto` plays exactly the file the source
  names; `Smallest` / `Largest` pick the smallest or largest version the item
  has. It is remembered across restarts.
- **YouTube: Auto (YouTube decides).** YouTube's embed publishes the level it
  is playing but ignores the command to change it, so the picker shows one
  disabled line — *Auto (YouTube decides)* — and Aura never sends a quality
  command or a `vq=` parameter that could break playback.
- **Direct files.** One file, so no picker is shown at all.

By voice: *“what quality can this film play at?”* → the agent calls
`aura_watch` with `action=quality`; *“play the smallest version”* →
`action=quality`, `preference=smallest`; *“use the 640×480 file”* →
`action=quality`, `n=1` (or the file's url).

## The control strip

The transport strip floats over the app, top to bottom: the **drag bar**, a
**seek bar across the whole strip**, the **clocks** (elapsed on the left,
time left and the film's length on the right), then the **big row of controls**.

- **Drag bar.** Drag it by the ⠿ grip — or by any empty part of the strip — and
  it stays where you dropped it, in every mode: dragging never pops the film out
  and never changes a mode. **Double-click the grip** to send it back to the
  bottom-left corner. A resize keeps it inside the window.
- **The bottom row.** Close (**✕**, far left, below the seek bar and the clocks
  so a drag can never land on it), previous, play/pause, next, volume, **CC**,
  and on the right **Frame in Hermes** and **Pop out to desktop** together. Every
  control is a 36px target; on a narrow window the row wraps instead of
  overflowing.
- **See-through.** The strip is translucent so the film reads through it, and
  fully solid while the pointer is over it or it holds the keyboard. Settings ▸
  Plugins ▸ Aura ▸ **Controls transparency** sets the level (20–100%).
- **Wheel.** Over the seek bar it seeks 5 seconds a notch; over the volume it
  changes the level 5% a notch.
- **Keyboard.** Tab to the strip, then **Left/Right** seek ±5 s, **Up/Down**
  change the volume ±5%, **Space** plays or pauses, **C** toggles captions, and
  **Esc** hands the keyboard back to the chat. While you are typing in the chat
  the strip never takes a key.

Only **Frame in Hermes** and **Pop out to desktop** (in the strip, on the page or
in the panel) move the film between surfaces. Nothing else does.

## Add a YouTube playlist

1. Open the playlist on YouTube.
2. Press **Share**, then **Copy link** — it looks like
   `https://youtube.com/playlist?list=PL…`.
3. On the Aura page, paste it into the Library box, give it a name if you like,
   and press **Add**.

Public and unlisted playlists play here. Private playlists cannot be embedded
and are not supported.

Playlist episodes are resolved server-side. If an item forbids embedding or has
been deleted, Aura skips to the next playable episode instead of breaking the
whole list.

## Move the film between surfaces

The film exists in one place at a time:

- **Docked pane** — beside the chat, for working with it visible.
- **Aura page** — the whole product in one screen: stage, transport, Library,
  settings.
- **Pop-out window** — ordinary Chromium on its own profile, so it can go
  full-screen on another monitor.

Use **Pop out** on the page or the control strip. The window opens at the second
the in-app player had reached, and the in-app player pauses so two copies never
play with sound. **Pop in** closes it. If the Aura server restarts or the app
quits, the window closes with it.

The pop-out needs Chrome or Chromium. Set `AURA_DESKTOP_BROWSER=/path/to/chrome`
if it cannot find one.

## Manage a playlist where it lives

`☰` hands the list to the pop-out window, which is real Chromium on Aura's own
profile. YouTube's own page opens, so adding, removing and reordering work with
your own session. No API scope, no OAuth review, no second account.

## The Aura page

The sidebar **Aura** page puts the same player in a big 16:9 frame with the
transport, volume and source picker. Directly above the frame, **Now playing**
names the film — its title in large type and, when the player knows it, the
channel underneath. It follows the film as it plays: a playlist moving to the
next episode, or another source picked, retitles it at once. A source Aura has
not opened yet shows the title it already stores for it; the URL is never used
as a title. Under the player:

- **Library** — Picks first, then one scrolling row per catalogue category; one
  search box filters them all. Below that: add, rename, remove, hide starters,
  clear recents.
- **Playlist how-to** — the three steps above, in place.
- **Settings** — every control Aura has.

**Pop out** floats the film into a watch window; **Bring back** returns it. The
film moves into the page while it is open and goes back when you leave.

One library feeds two pickers: the source dropdowns in the A menu and in
Settings both list saved playlists, your films, the starter pack and recents,
grouped under `Playlists`, `Your films`, `Starters` and `Recent`.

The starter pack is meant to be left running behind work. It holds 32 sources,
24 of them added for the backdrop: sixteen run 2–12 hours — BBC Earth's
oceanscapes, NASA+ and ISS material, Monterey Bay Aquarium tanks, Alpine and
Iberian cab rides, city walks, silent drone aerials, and rain or fireplace beds.
The shorter entries include Blender's open movies (CC-BY), two NASA films and
public-domain features from the Internet Archive. Every entry is the
rights-holder's own upload or a direct file, so nothing in the pack is a
reupload; **Hide starters** clears the whole list in one click.

## Watch the visualiser

Switch the film off and the same system audio drives a MilkDrop-compatible
WebGL visualiser behind the interface.

![Tokamak witchery preset](screenshots/visualiser-tokamak-witchery.png)

- Driven by system audio: level, eight bands, onset and silence gating.
- Backdrop opacity that follows the room: dim when quiet, brighter with music.
- Optional accent pulse and agent moods: thinking, running tools, waiting for
  approval, erroring, streaming, finished. Each restores itself; nothing latches.

A film owns the screen while **Backdrop** is **Video player**: Style, Intensity,
the Aura transparency and Gentle motion are greyed out, and Show is forced to
Always in effect. Your stored Show choice is not overwritten.

## Listen to anything

Aura listens to more than a film's soundtrack. Internet radio, direct audio
files and streams play on their own channel, beside the video and independent
of it.

- **Radio** — a curated starter list (SomaFM, NTS, KEXP, FIP, Radio Paradise,
  BBC World Service and more), search across the Radio Browser directory by name
  or genre tag, and favourites that persist between sessions. `.pls` and `.m3u`
  playlists are resolved server-side.
- **Direct audio** — any public `http(s)` URL to mp3, ogg/opus, aac/m4a, flac or
  wav.
- **Music on, video muted** — the audio channel has its own volume and mute.
  The muted state is remembered with the film.
- **Closing the film does not stop the music** — the audio channel lives in the
  one page Aura frames, so with the film closed that page stays up as the
  visualiser and the music keeps playing.
- **Visuals follow it** — music from Aura's channel (or any other app) drives
  the same visuals.

## Talk to Hermes

Because the server is the remote, the chat can drive the film without alt-tab:

- “pause” / “resume” / “next episode” / “go back an episode”
- “jump to 40 minutes” (seek)
- “put it on my other screen” / “pop the film out” / “bring it back into Hermes”
- “find me something to watch” → numbered choices → “the second one”
- “find me some jazz radio” → numbered choices → “the second one”

The agent calls `aura_control`, `aura_watch` and `aura_listen`; see
[REFERENCE.md](REFERENCE.md) for every action and parameter. Search never
autoplays: options are shown, and playback waits for your pick.

## Make the chat readable over a film

**Settings ▸ Plugins ▸ Aura ▸ Readable.** One switch, then three choices:

| Choice | Options | What it changes |
|---|---|---|
| Text size | S / M / L / XL | The theme's base font size, with line spacing growing alongside it. M is the size the app already uses. |
| Text font | System / Atkinson Hyperlegible / Inter / Mono | The app-wide face. Atkinson Hyperlegible is designed for low vision; System and Mono need no download. |
| Text colour | White / Warm / High-contrast yellow | The theme's text colour and its quieter secondary, on both the light and dark palettes. |

Readable works by changing the theme Aura contributes, not by styling the app:
the choices become the host theme's own typography and colour tokens and the
host paints them, so nothing here can fight a future Hermes release. Turning it
on wears the Aura Live theme; turning it off gives your own theme back, and
**Restore my theme** clears Readable too.

Hermes keeps its own chat face in **Settings ▸ Appearance ▸ Chat font**; the
Readable group has a shortcut to it. That setting overrides the chat alone,
while Readable sets the face everywhere the theme applies.

## Stop it, remove it, find your data

- **Stop now:** turn Aura off in **Settings ▸ Plugins ▸ Aura**. Capture stops,
  the mood machine resets, and every effect Aura applied is removed.
- **Restore the theme:** **Restore my theme** removes the host styling Aura
  added.
- **Uninstall:** remove the plugin through Hermes' plugin list. No background
  process survives that; the local server exits with the plugin process.
- **Data:** settings, token, lease, lock and radio favourites live in
  `~/.hermes/aura/` ([CONFIGURATION.md](CONFIGURATION.md)). Delete that folder
  to remove everything Aura stored.

Back to [docs/README.md](README.md).
