# Aura limits

The optional visual behind the app uses host background styling to show the visualizer through panels. It can affect layouts or contrast; turn off Visual behind the app or choose Restore my theme to remove it. Real-desktop layout and visual checks are still required.

## Single-server election is POSIX-only

Leader election uses `fcntl.flock`. On Windows (no `fcntl`) the import is guarded and Aura keeps
its previous per-process behaviour: each importing process/module copy may start its own server.
`lease.json` is still written by each server there, but followers are not used.

## Subtitles burned into the picture cannot be switched off

The CC switch drives the caption *track*: `cc_load_policy` on the embed, the captions module on a
live YouTube player, and `textTracks` on a direct file. When a video's subtitles are painted into
the picture itself, no player API exposes them and Aura cannot remove them — the button still
toggles the (unused) track. This is the uploader's choice, not a setting Aura hides.
