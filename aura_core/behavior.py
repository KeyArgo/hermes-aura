"""Aura behaviour profiles (CONTRACT.md §9, additive).

A single ``behavior`` setting selects one of three named profiles.  Each
profile maps to concrete, measurable render parameters — it is not a label:

    intensity_ceiling   upper bound on the effective intensity (0..1)
    pulse_hz_max        cap on accent-pulse rate; 0 means "no hard pulse"
    preset_family       preferred preset family (see web/presets.json)
    blend_ms            preset blend time used for rotation
    mood_gain_scale     how strongly a mood may lift the render (1 = full)
    allow_strobe        whether strobe-flagged presets may be chosen
    hard_pulse          whether attention moods pulse at all

Hard invariants that every profile keeps (CONTRACT.md §4):

* an attention pulse is never faster than 2 Hz (``pulse_hz_max <= 2``);
* the page's flash limiter stays at <= 3 flashes/s;
* ``done`` still settles to idle within 1.5 s;
* restore-on-clear is unchanged.

``calm`` is the reduced-motion-safe profile: no strobe presets, the lowest
intensity ceiling and no hard pulses (a static accent wash instead).

Stdlib only, no I/O, no mutable module state.
"""

from __future__ import annotations

__all__ = [
    "BEHAVIORS",
    "DEFAULT_BEHAVIOR",
    "BEHAVIOR_PROFILES",
    "PROFILE_KEYS",
    "is_behavior",
    "profile",
    "PROFILE_PRESET_FAMILIES",
]

BEHAVIORS = ("calm", "balanced", "intense")
DEFAULT_BEHAVIOR = "balanced"

#: Concrete mapping.  Keep in sync with web/aura.js (BEHAVIOR_PROFILES); the
#: server publishes this dict in /api/config so the page never has to guess.
BEHAVIOR_PROFILES = {
    "calm": {
        "intensity_ceiling": 0.6,
        "pulse_hz_max": 0.0,
        "preset_family": "organic",
        "blend_ms": 2400,
        "mood_gain_scale": 0.35,
        "allow_strobe": False,
        "hard_pulse": False,
    },
    "balanced": {
        "intensity_ceiling": 1.0,
        "pulse_hz_max": 1.0,
        "preset_family": "liquid",
        "blend_ms": 1200,
        "mood_gain_scale": 1.0,
        "allow_strobe": True,
        "hard_pulse": True,
    },
    "intense": {
        "intensity_ceiling": 1.0,
        "pulse_hz_max": 2.0,
        "preset_family": "geometric",
        "blend_ms": 600,
        "mood_gain_scale": 1.35,
        "allow_strobe": True,
        "hard_pulse": True,
    },
}

PROFILE_KEYS = (
    "intensity_ceiling",
    "pulse_hz_max",
    "preset_family",
    "blend_ms",
    "mood_gain_scale",
    "allow_strobe",
    "hard_pulse",
)

#: Families that exist in web/presets.json (checked by tests).
PROFILE_PRESET_FAMILIES = frozenset(
    {p["preset_family"] for p in BEHAVIOR_PROFILES.values()}
)

#: Never exceed the contract's attention pulse ceiling.
MAX_PULSE_HZ = 2.0


def is_behavior(value) -> bool:
    return isinstance(value, str) and value in BEHAVIORS


def profile(behavior: str) -> dict:
    """Return a copy of the concrete profile for ``behavior``.

    Unknown names raise ``ValueError`` so /api/control can answer 400; config
    normalisation coerces instead (a corrupt file must never break serving).
    """
    if not is_behavior(behavior):
        raise ValueError(f"unknown behavior {behavior!r}; expected one of {BEHAVIORS}")
    out = dict(BEHAVIOR_PROFILES[behavior])
    # Invariant guard: a future edit must not break the 2 Hz contract cap.
    out["pulse_hz_max"] = min(float(out["pulse_hz_max"]), MAX_PULSE_HZ)
    return out
