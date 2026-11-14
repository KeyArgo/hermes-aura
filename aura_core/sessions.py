"""Dynamic intensity from active Hermes chat sessions (CONTRACT.md §9.6).

Aura gets louder as more chats are open.  The session count comes from the
registry Hermes already maintains for its cross-process active chat leases:
``<HERMES_HOME>/runtime/active_sessions.json``.  When the Hermes agent package
is importable (the normal plugin/gateway case) its own snapshot helper is used,
so dead leases are pruned exactly like Hermes does it; otherwise a tolerant,
stdlib-only reader counts entries whose owner pid is still alive.

Stdlib only, no module-level mutable state, every entry point swallows errors.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import config, proc

__all__ = [
    "BOOST_PER_SESSION",
    "MAX_SESSIONS_FOR_BOOST",
    "boost_multiplier",
    "dynamic_intensity",
    "active_session_count",
]

#: Each additional active chat adds 15% of the user's saved intensity.
BOOST_PER_SESSION = 0.15
#: The boost stops growing after ten sessions (multiplier 2.5).
MAX_SESSIONS_FOR_BOOST = 10


def _as_count(value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def boost_multiplier(count) -> float:
    """Multiplier for the saved intensity: ``1 + 0.15 * min(N, 10)``.

    N=0 -> 1.0, N=1 -> 1.15, N=5 -> 1.75, N>=10 -> 2.5.  The final intensity
    is saturated at 1.0 by :func:`dynamic_intensity`.
    """
    n = min(_as_count(count), MAX_SESSIONS_FOR_BOOST)
    return 1.0 + BOOST_PER_SESSION * n


def dynamic_intensity(base, count=None) -> float:
    """Scale ``base`` (the user's saved 0..1 intensity) by the session boost.

    ``count`` is injected for tests; ``None`` reads the live session count.
    The result is always within 0..1.
    """
    try:
        base_f = 0.0 if isinstance(base, bool) else float(base)
    except (TypeError, ValueError, OverflowError):
        base_f = 0.0
    base_f = max(0.0, min(1.0, base_f))
    if count is None:
        count = active_session_count()
    return max(0.0, min(1.0, base_f * boost_multiplier(count)))


def _pid_alive(pid) -> bool:
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return True  # no usable pid: do not hide a lease we cannot judge
    # Never os.kill(pid, 0) on Windows: there it sends Ctrl+C to the process group.
    if os.name == "nt":
        return proc.pid_alive_windows(pid)
    return proc.pid_alive_posix(pid)


def _read_registry_entries() -> list:
    """Fallback reader for ``runtime/active_sessions.json`` (never raises)."""
    try:
        path = Path(config.hermes_home()) / "runtime" / "active_sessions.json"
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return []
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return []
    return [
        entry for entry in entries
        if isinstance(entry, dict) and _pid_alive(entry.get("pid"))
    ]


def active_session_count() -> int:
    """Number of live active chat sessions, or 0 when the registry is unavailable.

    Prefers Hermes' own ``active_session_registry_snapshot()`` (which also
    prunes dead leases); falls back to reading the registry file directly.
    """
    try:
        from hermes_cli.active_sessions import active_session_registry_snapshot
        return len(active_session_registry_snapshot())
    except Exception:  # noqa: BLE001 - agent package absent or registry unreadable
        pass
    try:
        return len(_read_registry_entries())
    except Exception:  # noqa: BLE001 - a broken registry must never break Aura
        return 0
