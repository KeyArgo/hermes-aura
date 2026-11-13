# Aura limits

The optional visual behind the app uses host background styling to show the visualizer through panels. It can affect layouts or contrast; turn off Visual behind the app or choose Restore my theme to remove it. Real-desktop layout and visual checks are still required.

## Single-server election is POSIX-only

Leader election uses `fcntl.flock`. On Windows (no `fcntl`) the import is guarded and Aura keeps
its previous per-process behaviour: each importing process/module copy may start its own server.
`lease.json` is still written by each server there, but followers are not used.

## YouTube chooses its own quality, and cannot be told otherwise

The embed publishes the level it is playing (`playbackQuality`), the levels it has
(`availableQualityLevels`) and its own preference, but the IFrame API's
`setPlaybackQuality` is deprecated and ignored. Measured in headless Chromium against
Aura's own player page: sending `small`, `medium`, `hd720`, `hd1080`, `large` and
`default` left `playbackQuality` at `hd1080` and `preferredQuality` at `auto`, and
`getAvailableQualityLevels` has no return channel at all. The Quality control therefore
shows one disabled line — *Auto (YouTube decides)* — and Aura sends no quality command
and no `vq=` parameter, because a hack that pretends to work is worse than a control
that says what it can do. archive.org films are the opposite: their files are real, so
they are listed and switchable.

## Subtitles burned into the picture cannot be switched off

The CC switch drives the caption *track*: `cc_load_policy` on the embed, the captions module on a
live YouTube player, and `textTracks` on a direct file. When a video's subtitles are painted into
the picture itself, no player API exposes them and Aura cannot remove them — the button still
toggles the (unused) track. This is the uploader's choice, not a setting Aura hides.
