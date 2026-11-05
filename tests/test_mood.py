"""Unit tests for aura_core.mood — CONTRACT.md §4.

Everything runs against an injected fake clock: no sleeps, no I/O.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import mood as m  # noqa: E402


class FakeClock:
    def __init__(self, seconds: float = 1000.0):
        self.seconds = seconds

    def __call__(self) -> float:
        return self.seconds

    def advance(self, ms: int) -> None:
        self.seconds += ms / 1000.0


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def machine(clock):
    return m.MoodMachine(clock=clock)


# ---------------------------------------------------------------------------
# surface
# ---------------------------------------------------------------------------

def test_mood_enum_and_attention_set():
    assert m.MOODS == ("idle", "thinking", "tool", "approval", "error",
                       "streaming", "done")
    assert m.ATTENTION_MOODS == frozenset({"approval", "error"})
    assert set(m.FLASH_ALLOWED) == set(m.MOODS)
    assert set(m.DEFAULT_TTL_MS) == set(m.MOODS)
    assert set(m.DEFAULT_INTENSITY) == set(m.MOODS)


def test_starts_idle(machine):
    state = machine.snapshot()
    assert state.mood == "idle"
    assert state.intensity == 0.0
    assert state.ttl_ms == 0
    assert state.expires_at_ms is None
    assert state.flash_allowed is False


def test_unknown_mood_rejected(machine):
    with pytest.raises(ValueError):
        machine.set("party")


# ---------------------------------------------------------------------------
# transitions
# ---------------------------------------------------------------------------

def test_thinking_transition_has_ttl(machine, clock):
    state = machine.set("thinking")
    assert state.mood == "thinking"
    assert state.ttl_ms == m.DEFAULT_TTL_MS["thinking"]
    assert state.expires_at_ms == int(clock() * 1000) + state.ttl_ms
    assert 0.0 <= state.intensity <= 1.0


def test_tool_transition(machine):
    state = machine.set("tool")
    assert state.mood == "tool"
    assert state.ttl_ms > 0
    assert state.pulse_hz <= m.MAX_PULSE_HZ


def test_streaming_transition(machine):
    state = machine.set("streaming")
    assert state.mood == "streaming"
    assert state.ttl_ms > 0


def test_each_transition_bumps_revision(machine):
    first = machine.set("thinking")
    second = machine.set("tool")
    assert second.revision > first.revision


# ---------------------------------------------------------------------------
# ttl expiry
# ---------------------------------------------------------------------------

def test_mood_expires_to_idle_after_ttl(machine, clock):
    machine.set("tool", ttl_ms=1000)
    clock.advance(999)
    assert machine.tick().mood == "tool"
    clock.advance(1)
    state = machine.tick()
    assert state.mood == "idle"
    assert state.ttl_ms == 0


def test_remaining_ms_counts_down(machine, clock):
    machine.set("thinking", ttl_ms=5000)
    assert machine.remaining_ms() == 5000
    clock.advance(2000)
    assert machine.remaining_ms() == 3000
    clock.advance(3000)
    assert machine.remaining_ms() == 0


# ---------------------------------------------------------------------------
# restore-on-clear
# ---------------------------------------------------------------------------

def test_approval_expires_back_to_previous_mood(machine, clock):
    machine.set("tool", ttl_ms=600_000)
    clock.advance(1000)
    approval = machine.set("approval", ttl_ms=2000)
    assert approval.mood == "approval"
    assert approval.restore_mood == "tool"
    clock.advance(2000)
    state = machine.tick()
    assert state.mood == "tool"
    assert state.ttl_ms == m.DEFAULT_TTL_MS["tool"]


def test_error_expires_back_to_previous_mood(machine, clock):
    machine.set("streaming", ttl_ms=600_000)
    machine.set("error", ttl_ms=3000)
    clock.advance(3000)
    assert machine.tick().mood == "streaming"


def test_clear_restores_previous_mood(machine):
    machine.set("thinking")
    machine.set("approval")
    state = machine.clear("approval")
    assert state.mood == "thinking"


def test_clear_wrong_mood_is_noop(machine):
    machine.set("tool")
    state = machine.clear("approval")
    assert state.mood == "tool"


def test_attention_from_idle_returns_to_idle(machine, clock):
    machine.set("approval", ttl_ms=1000)
    clock.advance(1000)
    assert machine.tick().mood == "idle"


def test_clear_non_attention_falls_to_idle(machine):
    machine.set("thinking")
    assert machine.clear().mood == "idle"


# ---------------------------------------------------------------------------
# attention never latches
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("attention", ["approval", "error"])
def test_attention_ttl_is_capped(machine, clock, attention):
    state = machine.set(attention, ttl_ms=10_000_000)
    assert state.ttl_ms == m.ATTENTION_MAX_TTL_MS
    assert state.expires_at_ms is not None
    clock.advance(m.ATTENTION_MAX_TTL_MS)
    assert machine.tick().mood == "idle"


@pytest.mark.parametrize("attention", ["approval", "error"])
def test_attention_zero_ttl_still_finite(machine, attention):
    state = machine.set(attention, ttl_ms=0)
    assert state.ttl_ms >= 1


def test_repeated_attention_keeps_original_restore_target(machine, clock):
    machine.set("tool")
    machine.set("approval", ttl_ms=1000)
    machine.set("error", ttl_ms=1000)
    clock.advance(1000)
    assert machine.tick().mood == "tool"


# ---------------------------------------------------------------------------
# done settle
# ---------------------------------------------------------------------------

def test_done_settles_within_1_5s(machine, clock):
    state = machine.set("done", ttl_ms=10_000)
    assert state.mood == "done"
    assert state.ttl_ms <= 1500
    assert state.ttl_ms == m.DONE_MAX_TTL_MS
    clock.advance(1499)
    assert machine.tick().mood == "done"
    clock.advance(1)
    assert machine.tick().mood == "idle"


def test_done_short_ttl_kept(machine, clock):
    state = machine.set("done", ttl_ms=400)
    assert state.ttl_ms == 400
    clock.advance(400)
    assert machine.tick().mood == "idle"


# ---------------------------------------------------------------------------
# intensity / pulse / flash caps
# ---------------------------------------------------------------------------

def test_attention_intensity_floor(machine):
    state = machine.set("approval", intensity=0.05)
    assert state.intensity >= m.ATTENTION_FLOOR
    state = machine.set("error", intensity=0.0)
    assert state.intensity >= m.ATTENTION_FLOOR


def test_attention_floor_beats_user_cap(clock):
    machine = m.MoodMachine(clock=clock, intensity_cap=0.2)
    assert machine.set("approval").intensity >= m.ATTENTION_FLOOR
    assert machine.set("error").intensity >= m.ATTENTION_FLOOR


def test_non_attention_respects_cap(clock):
    machine = m.MoodMachine(clock=clock, intensity_cap=0.2)
    state = machine.set("thinking", intensity=1.0)
    assert state.intensity == pytest.approx(0.2)
    state = machine.set("streaming", intensity=0.9)
    assert state.intensity <= 0.2


def test_attention_pulse_never_exceeds_2hz(machine):
    for attention in ("approval", "error"):
        state = machine.set(attention)
        assert state.pulse_hz <= m.MAX_PULSE_HZ
        assert state.pulse_hz == 2.0


def test_flash_allowed_flags(machine):
    expected = {
        "idle": False,
        "thinking": False,
        "tool": False,
        "approval": True,
        "error": True,
        "streaming": False,
        "done": True,
    }
    for mood_name, allowed in expected.items():
        assert machine.set(mood_name).flash_allowed is allowed


def test_intensity_always_in_range(machine):
    for mood_name in m.MOODS:
        state = machine.set(mood_name, intensity=5.0)
        assert 0.0 <= state.intensity <= 1.0


def test_set_cap_clamps(machine):
    assert machine.set_cap(5.0) == 1.0
    assert machine.set_cap(-1.0) == 0.0
    assert machine.set_cap("junk") == 1.0


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------

def test_reset_returns_to_idle_and_drops_restore(machine, clock):
    machine.set("thinking")
    machine.set("approval", ttl_ms=1000)
    state = machine.reset()
    assert state.mood == "idle"
    assert state.intensity == 0.0
    assert state.ttl_ms == 0
    assert state.expires_at_ms is None
    clock.advance(100_000)
    assert machine.tick().mood == "idle"


def test_reset_after_done(machine, clock):
    machine.set("done")
    machine.reset()
    clock.advance(10_000)
    assert machine.tick().mood == "idle"


def test_machines_are_independent(clock):
    a = m.MoodMachine(clock=clock)
    b = m.MoodMachine(clock=clock)
    a.set("tool")
    assert b.snapshot().mood == "idle"
