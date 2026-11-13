"""Intensity scaling (CONTRACT.md §9.6) — without the private session registry.

Aura used to get louder as more Hermes chats were open. It learned that number
two ways, and both were private: ``hermes_cli.active_sessions`` (a core module
that can move on any release) and a direct read of
``<HERMES_HOME>/runtime/active_sessions.json`` (a file whose layout is nobody's
public promise). Nous asked for both to go, and they are gone.

Consequence, stated plainly: **the number of open chats no longer changes the
visual.** Every connected surface renders the intensity the user saved. When
Hermes exposes a public active-session count, this module is the one place that
changes — the request is drafted outside the repo, with the plugin's
other Hermes issue requests.

The public functions are kept so the server and the pages keep one mapping from
"what the user saved" to "what is rendered", and they clamp exactly as before.

Stdlib only, no module-level mutable state, every entry point swallows errors.
"""

from __future__ import annotations

__all__ = [
    "BOOST_PER_SESSION",
    "MAX_SESSIONS_FOR_BOOST",
    "boost_multiplier",
    "dynamic_intensity",
    "active_session_count",
]

#: Retained for the wire format (CONTRACT.md §9.6). The boost is now always 1.0,
#: so this constant only records what the number used to mean.
BOOST_PER_SESSION = 0.15
#: Retained with :data:`BOOST_PER_SESSION`; see above.
MAX_SESSIONS_FOR_BOOST = 10


def boost_multiplier(count) -> float:
    """The multiplier applied to the saved intensity — 1.0, always.

    Kept as a function because the server publishes ``session_boost`` on the
    wire and the pages read it: a missing key would be a protocol break, while a
    fixed 1.0 is the honest value.
    """
    return 1.0


def dynamic_intensity(base, count=None) -> float:
    """Clamp ``base`` (the user's saved 0..1 intensity) into 0..1.

    ``count`` is accepted and ignored so existing callers keep working; the
    number of open chats no longer scales anything.
    """
    try:
        base_f = 0.0 if isinstance(base, bool) else float(base)
    except (TypeError, ValueError, OverflowError):
        base_f = 0.0
    return max(0.0, min(1.0, base_f))


def active_session_count() -> int:
    """Always 0: Aura no longer reads Hermes' private active-session registry.

    Returning 0 rather than guessing keeps the published shape stable — the
    pages read a number, get one, and render the user's saved intensity.
    """
    return 0
