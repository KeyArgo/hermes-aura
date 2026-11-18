# Aura limits

This build does not paint a visual behind the app. The visualiser and the film stay inside Aura's own panel, page, or watch window. The full-window visual returns when Hermes ships a backdrop area (#155903). Real-desktop layout and visual checks are still required.

## Single-server election

Aura uses `fcntl.flock` on POSIX and a named mutex on Windows to elect one
server per Hermes home.
