"""Aura mood state machine (L4 owns this file, CONTRACT.md §4).

Pure Python, stdlib only, no I/O and no module-level mutable state.  All time
comes from an injected monotonic clock, so the whole machine is deterministic
in tests.

Rules implemented here (CONTRACT.md §4):

* ``approval`` and ``error`` are attention moods: intensity is at least 0.6,
  the pulse rate never exceeds 2 Hz, and their ttl is finite and capped, so
  they expire back to the previous non-attention mood (restore-on-clear)
  instead of latching forever.
* ``done`` is a short settle (never longer than 1.5 s) that falls to ``idle``.
* ``reset()`` clears every trace, so a re-enable starts at ``idle``.
* Every mood carries ``flash_allowed`` for the visualizer.

The machine never changes audio; it only describes what the agent is doing.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

__all__ = [
    "MOODS",
    "ATTENTION_MOODS",
    "FLASH_ALLOWED",
    "PULSE_HZ",
    "DEFAULT_INTENSITY",
    "DEFAULT_TTL_MS",
    "MAX_PULSE_HZ",
    "ATTENTION_FLOOR",
    "ATTENTION_MAX_TTL_MS",
    "DONE_MAX_TTL_MS",
    "MoodState",
    "MoodMachine",
]

MOODS = ("idle", "thinking", "tool", "approval", "error", "streaming", "done")

ATTENTION_MOODS = frozenset({"approval", "error"})

#: Moods whose transition may flash the stage.  Attention moods may flash, but
#: their pulse is capped at MAX_PULSE_HZ so the flash never becomes a strobe.
FLASH_ALLOWED = {
    "idle": False,
    "thinking": False,
    "tool": False,
    "approval": True,
    "error": True,
    "streaming": False,
    "done": True,
}

#: Nominal pulse rate per mood (Hz).  Attention moods are additionally clamped
#: to MAX_PULSE_HZ at build time.
PULSE_HZ = {
    # a resting room still breathes: 0.15 Hz, one slow wave every ~7 s, never a strobe
    "idle": 0.15,
    "thinking": 0.5,
    "tool": 1.0,
    "approval": 2.0,
    "error": 2.0,
    "streaming": 0.5,
    "done": 0.0,
}

DEFAULT_INTENSITY = {
    # never zero: an untouched Aura is a calm, slowly moving field, not a black rectangle.
    # (0.0 here was the reason a first-time user saw an empty stage and thought it was broken.)
    "idle": 0.18,
    "thinking": 0.35,
    "tool": 0.50,
    "approval": 0.80,
    "error": 0.90,
    "streaming": 0.60,
    "done": 0.70,
}

#: Default lifetime of a mood before it expires.  ``done`` is clamped to
#: DONE_MAX_TTL_MS and attention moods to ATTENTION_MAX_TTL_MS.
DEFAULT_TTL_MS = {
    "idle": 0,
    "thinking": 180_000,
    "tool": 60_000,
    "approval": 30_000,
    "error": 15_000,
    "streaming": 1_800_000,
    "done": 1_500,
}

MAX_PULSE_HZ = 2.0
ATTENTION_FLOOR = 0.6
ATTENTION_MAX_TTL_MS = 60_000
DONE_MAX_TTL_MS = 1_500


def _as_float(value, default):
    if isinstance(value, bool) or value is None:
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _clamp01(value):
    return max(0.0, min(1.0, value))


@dataclass(frozen=True)
class MoodState:
    """Immutable snapshot of one mood transition."""

    mood: str
    intensity: float
    ttl_ms: int
    pulse_hz: float
    flash_allowed: bool
    since_ms: int
    expires_at_ms: int | None
    restore_mood: str | None
    revision: int

    def as_dict(self) -> dict:
        return {
            "mood": self.mood,
            "intensity": self.intensity,
            "ttl_ms": self.ttl_ms,
            "pulse_hz": self.pulse_hz,
            "flash_allowed": self.flash_allowed,
            "since_ms": self.since_ms,
            "expires_at_ms": self.expires_at_ms,
            "restore_mood": self.restore_mood,
            "revision": self.revision,
        }


class MoodMachine:
    """Clock-injectable mood state machine.

    ``clock`` is a callable returning monotonic seconds.  Tests pass a fake
    clock; production passes ``time.monotonic``.
    """

    def __init__(self, clock=None, intensity_cap: float = 1.0):
        self._clock = clock if clock is not None else time.monotonic
        self._lock = threading.RLock()
        self._cap = _clamp01(_as_float(intensity_cap, 1.0))
        self._revision = 0
        self._restore = None
        self._state = MoodState(
            mood="idle",
            intensity=0.0,
            ttl_ms=0,
            pulse_hz=0.0,
            flash_allowed=False,
            since_ms=self._now_ms(),
            expires_at_ms=None,
            restore_mood=None,
            revision=0,
        )

    # -- clock -----------------------------------------------------------
    def _now_ms(self) -> int:
        return int(round(float(self._clock()) * 1000.0))

    # -- state construction ----------------------------------------------
    def _state_for_locked(self, mood, ttl_ms, intensity, now, revision):
        if mood not in MOODS:
            raise ValueError(f"unknown mood {mood!r}; expected one of {MOODS}")
        if mood == "idle":
            ttl = 0
            inten = 0.0
        elif mood == "done":
            requested = DEFAULT_TTL_MS["done"] if ttl_ms is None else int(ttl_ms)
            ttl = max(1, min(requested, DONE_MAX_TTL_MS))
            inten = min(_as_float(intensity, DEFAULT_INTENSITY["done"]), self._cap)
        elif mood in ATTENTION_MOODS:
            requested = DEFAULT_TTL_MS[mood] if ttl_ms is None else int(ttl_ms)
            ttl = max(1, min(requested, ATTENTION_MAX_TTL_MS))
            # Attention floor wins over the user intensity cap: an approval or
            # an error must be visible even when the user turned intensity down.
            inten = max(
                ATTENTION_FLOOR,
                min(_as_float(intensity, DEFAULT_INTENSITY[mood]), 1.0),
            )
        else:
            requested = DEFAULT_TTL_MS[mood] if ttl_ms is None else int(ttl_ms)
            ttl = max(1, requested)
            inten = min(_as_float(intensity, DEFAULT_INTENSITY[mood]), self._cap)

        pulse = PULSE_HZ[mood]
        if mood in ATTENTION_MOODS:
            pulse = min(pulse, MAX_PULSE_HZ)
        expires = None if mood == "idle" else now + ttl
        return MoodState(
            mood=mood,
            intensity=round(_clamp01(inten), 4),
            ttl_ms=ttl,
            pulse_hz=pulse,
            flash_allowed=FLASH_ALLOWED[mood],
            since_ms=now,
            expires_at_ms=expires,
            restore_mood=self._restore,
            revision=revision,
        )

    # -- expiry ----------------------------------------------------------
    def _expire_locked(self, now):
        st = self._state
        if st.mood == "idle" or st.expires_at_ms is None or now < st.expires_at_ms:
            return
        if st.mood in ATTENTION_MOODS:
            target = self._restore
            if target not in ("thinking", "tool", "streaming"):
                target = "idle"
            self._restore = None if target == "idle" else target
        else:
            target = "idle"
            self._restore = None
        self._revision += 1
        self._state = self._state_for_locked(target, None, None, now, self._revision)

    # -- public API ------------------------------------------------------
    def set(self, mood: str, *, ttl_ms: int | None = None,
            intensity: float | None = None) -> MoodState:
        """Enter ``mood``, remembering the previous non-attention mood."""
        if mood not in MOODS:
            raise ValueError(f"unknown mood {mood!r}; expected one of {MOODS}")
        with self._lock:
            now = self._now_ms()
            self._expire_locked(now)
            if mood in ATTENTION_MOODS:
                current = self._state.mood
                if current not in ATTENTION_MOODS:
                    # Remember where to go back to when the attention clears.
                    self._restore = current
                # Re-entering the same attention mood keeps the original target.
            elif mood in ("idle", "done"):
                self._restore = None
            else:
                self._restore = mood
            self._revision += 1
            self._state = self._state_for_locked(
                mood, ttl_ms, intensity, now, self._revision
            )
            return self._state

    def clear(self, mood: str | None = None) -> MoodState:
        """Clear the current mood (or ``mood`` only when it is current).

        Attention moods restore the previous non-attention mood; everything
        else falls to idle.  A mismatched ``mood`` is a no-op.
        """
        with self._lock:
            now = self._now_ms()
            self._expire_locked(now)
            st = self._state
            if st.mood == "idle":
                return st
            if mood is not None and st.mood != mood:
                return st
            if st.mood in ATTENTION_MOODS:
                target = self._restore
                if target not in ("thinking", "tool", "streaming"):
                    target = "idle"
                self._restore = None if target == "idle" else target
            else:
                target = "idle"
                self._restore = None
            self._revision += 1
            self._state = self._state_for_locked(target, None, None, now, self._revision)
            return self._state

    def tick(self) -> MoodState:
        """Apply any due expiry and return the current state."""
        with self._lock:
            self._expire_locked(self._now_ms())
            return self._state

    def snapshot(self) -> MoodState:
        """Current state after applying due expiry."""
        return self.tick()

    def remaining_ms(self) -> int:
        with self._lock:
            self._expire_locked(self._now_ms())
            st = self._state
            if st.expires_at_ms is None:
                return 0
            return max(0, st.expires_at_ms - self._now_ms())

    def set_cap(self, intensity_cap: float) -> float:
        """Set the user intensity cap (0..1) for future non-attention moods."""
        with self._lock:
            self._cap = _clamp01(_as_float(intensity_cap, 1.0))
            return self._cap

    def reset(self) -> MoodState:
        """Return to a clean idle state (used on disable / fresh session)."""
        with self._lock:
            self._revision += 1
            self._restore = None
            self._state = MoodState(
                mood="idle",
                intensity=0.0,
                ttl_ms=0,
                pulse_hz=0.0,
                flash_allowed=False,
                since_ms=self._now_ms(),
                expires_at_ms=None,
                restore_mood=None,
                revision=self._revision,
            )
            return self._state
