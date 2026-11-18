# Aura limits

The optional visual behind the app uses host background styling to show the visualizer through panels. It can affect layouts or contrast; turn off Visual behind the app or choose Restore my theme to remove it. Real-desktop layout and visual checks are still required.

## Single-server election

Aura uses `fcntl.flock` on POSIX and a named mutex on Windows to elect one
server per Hermes home.
