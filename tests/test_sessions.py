"""Dynamic intensity from active chat sessions — CONTRACT.md §9.6."""

from __future__ import annotations

import json
import os
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import sessions  # noqa: E402


# ---------------------------------------------------------------------------
# boost math
# ---------------------------------------------------------------------------

def test_zero_sessions_is_base():
    assert sessions.boost_multiplier(0) == 1.0
    assert sessions.dynamic_intensity(0.5, count=0) == 0.5


def test_one_session_boosts_by_15_percent():
    assert sessions.boost_multiplier(1) == pytest.approx(1.15)
    assert sessions.dynamic_intensity(0.4, count=1) == pytest.approx(0.46)


def test_five_sessions_boost_by_75_percent():
    assert sessions.boost_multiplier(5) == pytest.approx(1.75)
    assert sessions.dynamic_intensity(0.4, count=5) == pytest.approx(0.7)


def test_ten_sessions_cap_multiplier_then_saturate():
    assert sessions.boost_multiplier(10) == pytest.approx(2.5)
    # base * 2.5 = 1.25, saturated to the 0..1 contract range
    assert sessions.dynamic_intensity(0.5, count=10) == 1.0
    assert sessions.boost_multiplier(50) == pytest.approx(2.5)


def test_low_base_stays_under_one_at_max_boost():
    assert sessions.dynamic_intensity(0.3, count=10) == pytest.approx(0.75)


def test_bad_counts_and_bases_are_tolerated():
    assert sessions.boost_multiplier(None) == 1.0
    assert sessions.boost_multiplier(-4) == 1.0
    assert sessions.boost_multiplier("loud") == 1.0
    assert sessions.dynamic_intensity(None, count=2) == 0.0
    assert sessions.dynamic_intensity(2.0, count=0) == 1.0
    assert sessions.dynamic_intensity(True, count=0) == 0.0


# ---------------------------------------------------------------------------
# session registry
# ---------------------------------------------------------------------------

def test_registry_fallback_counts_live_entries(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    entries = [
        {"lease_id": "a", "session_id": "s1", "pid": os.getpid(), "surface": "cli"},
        {"lease_id": "b", "session_id": "s2", "pid": os.getpid(), "surface": "desktop"},
        # A dead pid must not count when the Hermes snapshot helper is absent.
        {"lease_id": "c", "session_id": "s3", "pid": 999_999_999, "surface": "cli"},
    ]
    (runtime / "active_sessions.json").write_text(
        json.dumps({"entries": entries}), encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Force the stdlib fallback even when the agent package is importable.
    monkeypatch.setitem(sys.modules, "hermes_cli.active_sessions", None)
    assert sessions.active_session_count() == 2


def test_server_config_event_carries_session_boost():
    from aura_core import server

    with server._STATE.lock:
        old_count, old_boost = server._STATE.session_count, server._STATE.session_boost
        server._STATE.session_count, server._STATE.session_boost = 3, 1.45
    try:
        event = server._config_event()
        assert event["type"] == "config"
        assert event["sessions"] == 3
        assert event["session_boost"] == pytest.approx(1.45)
        # The user's saved intensity is untouched by the boost.
        assert event["intensity"] == 0.5
    finally:
        with server._STATE.lock:
            server._STATE.session_count, server._STATE.session_boost = old_count, old_boost


def test_missing_registry_is_zero(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert sessions._read_registry_entries() == []
    assert sessions.active_session_count() == 0


def test_corrupt_registry_is_zero(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "active_sessions.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert sessions._read_registry_entries() == []
