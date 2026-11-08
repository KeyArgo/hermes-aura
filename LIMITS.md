# Aura limits

The optional visual behind the app uses host background styling to show the visualizer through panels. It can affect layouts or contrast; turn off Visual behind the app or choose Restore my theme to remove it. Real-desktop layout and visual checks are still required.

## Single-server election is POSIX-only

Leader election uses `fcntl.flock`. On Windows (no `fcntl`) the import is guarded and Aura keeps
its previous per-process behaviour: each importing process/module copy may start its own server.
`lease.json` is still written by each server there, but followers are not used.
