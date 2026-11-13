"""Review 4 — no private active-session reads, and no per-chat boost.

The reviewed commit (90e8b80) imported ``hermes_cli.active_sessions`` and read
``runtime/active_sessions.json`` to make Aura louder as more chats opened. Both
were private: the module can move on any release and the file layout is nobody's
public promise. Nous asked for them to go.

These tests fail on 90e8b80 and pass after the removal. They also pin the
consequence, so the boost cannot come back by accident: the number of open chats
does not change the rendered intensity, and the wire keeps publishing
``session_boost`` at 1.0 so the pages do not lose a key.
"""

from __future__ import annotations

import inspect
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import server, sessions  # noqa: E402


def _code_only(source: str) -> str:
    """Source minus docstrings and comments — what a reviewer greps for."""
    stripped = []
    in_doc = False
    for line in source.splitlines():
        text = line.strip()
        if text.count('"""') == 1:
            in_doc = not in_doc
            continue
        if in_doc or text.startswith("#"):
            continue
        stripped.append(line.split("  #")[0])
    return "\n".join(stripped)


def test_sessions_module_imports_nothing_private():
    code = _code_only(inspect.getsource(sessions))
    assert "hermes_cli" not in code, "a core module is imported again"
    assert "active_sessions" not in code, "the private registry file is read again"
    assert "active_session_registry_snapshot" not in code


def test_the_server_starts_no_session_poll_thread():
    code = _code_only(inspect.getsource(server))
    assert "_session_boost_loop" not in code, "the 2 s registry poll is still there"
    assert "aura-sessions" not in code, "a session thread is still started"
    assert "active_session_registry_snapshot" not in code


def test_session_count_is_zero_and_the_boost_is_a_no_op():
    assert sessions.active_session_count() == 0
    assert sessions.boost_multiplier(0) == 1.0
    assert sessions.boost_multiplier(9) == 1.0, "open chats still change the visual"
    assert sessions.dynamic_intensity(0.5, count=9) == 0.5


def test_intensity_still_clamps_to_the_contract_range():
    assert sessions.dynamic_intensity(2.0) == 1.0
    assert sessions.dynamic_intensity(-1) == 0.0
    assert sessions.dynamic_intensity("nonsense") == 0.0
    assert sessions.dynamic_intensity(True) == 0.0


def test_the_wire_still_carries_session_boost():
    snapshot = server._session_boost_snapshot()
    assert snapshot["session_boost"] == 1.0
    assert snapshot["sessions"] == 0
