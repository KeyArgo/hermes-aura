"""Behaviour-profile mapping and config coercion tests (CONTRACT.md §9).

Pure unit tests: no server, no browser.  They pin the numbers the page and the
desktop half rely on, and the invariants that must hold for every profile.
"""

from __future__ import annotations

import json

import pytest

from aura_core import behavior, config


def _preset_families():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[1]
    data = json.loads((root / "web" / "presets.json").read_text(encoding="utf-8"))
    return {p.get("family") for p in data["presets"]}


def test_profiles_are_named_and_complete():
    assert behavior.BEHAVIORS == ("calm", "balanced", "intense")
    for name in behavior.BEHAVIORS:
        prof = behavior.profile(name)
        assert set(prof) == set(behavior.PROFILE_KEYS)
        assert isinstance(prof["allow_strobe"], bool)
        assert isinstance(prof["hard_pulse"], bool)
        assert isinstance(prof["preset_family"], str)


def test_calm_is_reduced_motion_safe_and_gentler_than_balanced():
    calm = behavior.profile("calm")
    balanced = behavior.profile("balanced")
    intense = behavior.profile("intense")
    assert calm["intensity_ceiling"] < balanced["intensity_ceiling"]
    assert calm["pulse_hz_max"] == 0.0
    assert calm["hard_pulse"] is False
    assert calm["allow_strobe"] is False
    assert calm["mood_gain_scale"] < balanced["mood_gain_scale"]
    assert calm["blend_ms"] > balanced["blend_ms"]
    # intense really is more intrusive, not just a label
    assert intense["pulse_hz_max"] > balanced["pulse_hz_max"]
    assert intense["mood_gain_scale"] > balanced["mood_gain_scale"]
    assert intense["blend_ms"] < balanced["blend_ms"]
    assert intense["preset_family"] != balanced["preset_family"]


def test_every_profile_keeps_the_hard_invariants():
    for name in behavior.BEHAVIORS:
        prof = behavior.profile(name)
        assert 0.0 <= prof["intensity_ceiling"] <= 1.0
        assert 0.0 <= prof["pulse_hz_max"] <= 2.0  # approval pulse ≤ 2 Hz
        assert 0 <= prof["blend_ms"] <= 8000
        assert prof["mood_gain_scale"] > 0
        # calm must never strobe; nothing may claim a hard pulse at 0 Hz
        if name == "calm":
            assert prof["allow_strobe"] is False
            assert prof["hard_pulse"] is False
        if prof["hard_pulse"]:
            assert prof["pulse_hz_max"] > 0


def test_profile_rejects_unknown_names():
    with pytest.raises(ValueError):
        behavior.profile("loud")
    with pytest.raises(ValueError):
        behavior.profile(None)
    assert behavior.is_behavior("calm") and not behavior.is_behavior("CALM")
    assert behavior.is_behavior("CALM".lower())


def test_profile_families_exist_in_the_page_catalogue():
    families = _preset_families()
    assert families, "web/presets.json has no presets"
    assert behavior.PROFILE_PRESET_FAMILIES <= families


def test_config_defaults_include_display_controls():
    cfg = config.normalise({})
    assert cfg["opacity"] == 0.25
    assert cfg["behavior"] == "balanced"
    assert cfg["mood_reactive"] is True
    assert cfg["accent_pulse"] is False
    assert cfg["auto_preset"] is True
    assert cfg["theme_opt_in"] is False


def test_first_run_defaults_are_agent_led_and_gentle():
    # New users land on: agent+music motion, a quarter reaction, balanced
    # profile, quarter opacity (CONTRACT.md §9.1).
    cfg = config.normalise({})
    assert cfg["motion"] == "agent_music"
    assert cfg["intensity"] == 0.25
    assert cfg["behavior"] == "balanced"
    assert cfg["opacity"] == 0.25
    assert cfg == config.DEFAULTS


def test_saved_config_keeps_its_values_and_only_fills_missing_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "aura" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    saved = {"motion": "both", "intensity": 0.9, "behavior": "calm", "opacity": 0.8}
    path.write_text(json.dumps(saved), encoding="utf-8")
    cfg = config.load_config()
    assert cfg["motion"] == "both"
    assert cfg["intensity"] == 0.9
    assert cfg["behavior"] == "calm"
    assert cfg["opacity"] == 0.8
    # Only the keys the file never had fall back to the new defaults.
    assert cfg["reduced_motion"] is config.DEFAULTS["reduced_motion"]
    assert cfg["mood_reactive"] is config.DEFAULTS["mood_reactive"]


def test_new_install_defaults_are_a_quarter_for_intensity_and_opacity():
    """Owner ask: a new install starts at 25% reaction and 25% opacity.

    Defaults are first-run only; a saved value is kept as it is, and every value
    still clamps to 0..1 (CONTRACT.md §9.1).
    """
    assert config.DEFAULTS["intensity"] == 0.25
    assert config.DEFAULTS["opacity"] == 0.25
    fresh = config.normalise({})
    assert (fresh["intensity"], fresh["opacity"]) == (0.25, 0.25)

    saved = config.normalise({"intensity": 0.9, "opacity": 0.8})
    assert (saved["intensity"], saved["opacity"]) == (0.9, 0.8)

    clamped = config.normalise({"intensity": 4, "opacity": -1})
    assert clamped["intensity"] == 1.0
    assert clamped["opacity"] == 0.0


def test_theme_effects_are_opt_in_and_can_be_enabled_explicitly():
    assert config.normalise({"accent_pulse": True})["accent_pulse"] is True
    assert config.normalise({"theme_opt_in": True})["theme_opt_in"] is True


def test_config_motion_defaults_and_validation():
    assert config.MOTIONS == ("designs", "both", "music", "agent", "agent_music")
    cfg = config.normalise({})
    assert cfg["motion"] == "agent_music"
    for value in config.MOTIONS:
        assert config.normalise({"motion": value})["motion"] == value
    assert config.normalise({"motion": "DESIGNS"})["motion"] == "designs"
    assert config.normalise({"motion": "AGENT"})["motion"] == "agent"
    assert config.normalise({"motion": " Agent_Music "})["motion"] == "agent_music"
    for bad in ("", "loud", 3, None, True):
        assert config.normalise({"motion": bad})["motion"] == "agent_music"


def test_config_coerces_bad_display_values_instead_of_raising():
    cfg = config.normalise({
        "opacity": 5,
        "behavior": "LOUD",
        "mood_reactive": "off",
        "accent_pulse": 0,
        "auto_preset": "yes",
    })
    assert cfg["opacity"] == 1.0
    assert cfg["behavior"] == "balanced"
    assert cfg["mood_reactive"] is False
    assert cfg["accent_pulse"] is False
    assert cfg["auto_preset"] is True

    cfg = config.normalise({"opacity": -2, "behavior": "Calm"})
    assert cfg["opacity"] == 0.0
    assert cfg["behavior"] == "calm"

    cfg = config.normalise({"opacity": True, "behavior": 7})
    assert cfg["opacity"] == 0.25
    assert cfg["behavior"] == "balanced"
