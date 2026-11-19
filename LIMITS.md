# Aura limits

This build does not paint the Aura visualiser behind the app: the visualiser stays inside Aura's own panel, page, or watch window. A film can be sent behind the chat as an explicit, per-film opt-in ("Watch in: Behind chat"): one click-through iframe and one scoped glass stylesheet while that place is chosen, both removed when you pick another place, close the film or turn Aura off. A full-window visual of the Aura visualiser returns when Hermes ships a backdrop area (#155903). Real-desktop layout and visual checks are still required.

## Single-server election

Aura uses `fcntl.flock` on POSIX and a named mutex on Windows to elect one
server per Hermes home.
