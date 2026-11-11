"""aura_listen tool tests — schema, the numbered-choice flow, play/stop/volume,
the video mute pair, and honest degradation.

The server half is faked (``publish_audio_request`` records what would reach
the desktop); Radio Browser is replaced at the radio module, so no network is
touched.

Run: .venv/bin/python -m pytest tests/test_listen_tool.py -q
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_plugin():
    name = "aura_listen_plugin"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class FakeServer:
    """Records audio requests instead of touching a live server."""

    def __init__(self):
        self.port = None
        self.moods = []
        self.audio = []
        self.seq = 0

    def ensure_server(self):
        pass

    def get_port(self):
        return self.port

    def publish_mood(self, *args):
        self.moods.append(args)

    def publish_config(self):
        pass

    def stop_server(self):
        pass

    def publish_audio_request(self, url="", label="", action="play", value=None):
        self.seq += 1
        frame = {"url": url, "label": label, "action": action,
                 "seq": self.seq, "at": 1700000000000}
        if value is not None:
            frame["value"] = value
        self.audio.append(frame)
        return frame


@pytest.fixture()
def plugin(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    p = _load_plugin()
    fake = FakeServer()
    monkeypatch.setattr(p, "_server", fake)
    p._CFG.enabled = True
    p._CTX = None
    return p, fake


@pytest.fixture()
def stations(monkeypatch, plugin):
    """Radio Browser answers with two rows; stream checks are offline-safe."""
    p, _ = plugin
    rows = [
        {"id": "rb-1", "name": "Jazz FM", "url": "https://ice.example/jazz.mp3",
         "tags": ["jazz"], "bitrate": 128, "country": "UK", "source": "radiobrowser"},
        {"id": "rb-2", "name": "Jazz Lounge", "url": "https://ice.example/lounge.mp3",
         "tags": ["jazz", "lounge"], "bitrate": 96, "country": "DE", "source": "radiobrowser"},
    ]
    monkeypatch.setattr(p._radio, "search", lambda q, tag, limit: rows[:limit])
    monkeypatch.setattr(p._radio, "prepare_stream", lambda url: url)
    return rows


def _call(p, args):
    raw = p._tool_aura_listen(args)
    assert isinstance(raw, str)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# schema + registration
# ---------------------------------------------------------------------------

def test_schema_is_valid_and_explains_the_choice_flow(plugin):
    p, _ = plugin
    schema = p.SCHEMA_AURA_LISTEN
    assert schema["name"] == "aura_listen"
    params = schema["parameters"]
    assert params["required"] == ["action"]
    assert params["properties"]["action"]["enum"] == [
        "search_radio", "play", "stop", "volume", "mute_video", "unmute_video"]
    description = schema["description"].lower()
    for phrase in ("numbered", "wait", "search_radio", "mute_video"):
        assert phrase in description, f"the description must explain {phrase!r}"
    assert "never autoplay" in description
    json.dumps(schema)


def test_both_tools_register_in_the_aura_toolset(plugin):
    p, _ = plugin
    ctx = type("Ctx", (), {
        "tools": [],
        "hooks": [],
        "get_config": lambda self, key, default=None: default,
        "register_tool": lambda self, **kw: self.tools.append(kw),
        "register_hook": lambda self, name, fn: self.hooks.append((name, fn)),
    })()
    p.register(ctx)
    names = [tool["name"] for tool in ctx.tools]
    assert names == ["aura_control", "aura_listen", "aura_watch"]
    assert all(tool["toolset"] == "aura" for tool in ctx.tools)


# ---------------------------------------------------------------------------
# search_radio
# ---------------------------------------------------------------------------

def test_search_radio_returns_numbered_choices(plugin, stations):
    p, _ = plugin
    payload = _call(p, {"action": "search_radio", "q": "jazz", "limit": 2})
    assert payload["ok"] is True
    assert payload["count"] == 2
    assert [row["n"] for row in payload["stations"]] == [1, 2]
    assert payload["stations"][0]["url"] == "https://ice.example/jazz.mp3"
    assert payload["stations"][0]["id"] == "rb-1"
    assert "WAIT" in payload["next"]
    assert "play" in payload["next"]


def test_search_radio_falls_back_to_presets_on_an_outage(plugin, monkeypatch):
    p, _ = plugin

    def offline(*args, **kwargs):
        raise p._radio.RadioUnavailable("down")

    monkeypatch.setattr(p._radio, "search", offline)
    payload = _call(p, {"action": "search_radio", "limit": 5})
    assert payload["ok"] is True
    assert payload["stations"], "an outage still offers Aura's presets"
    assert "unreachable" in payload["note"]


def test_search_radio_rejects_bad_types(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "search_radio", "q": 5})
    assert payload["ok"] is False


# ---------------------------------------------------------------------------
# play
# ---------------------------------------------------------------------------

def test_play_publishes_one_audio_request(plugin, stations):
    p, fake = plugin
    payload = _call(p, {"action": "play", "url": "https://ice.example/jazz.mp3", "label": "Jazz FM"})
    assert payload["ok"] is True
    assert payload["label"] == "Jazz FM"
    assert len(fake.audio) == 1
    request = fake.audio[0]
    assert request["action"] == "play"
    assert request["url"] == "https://ice.example/jazz.mp3"
    assert request["seq"] == 1
    assert payload["audio_request"]["seq"] == 1


def test_play_accepts_a_preset_id(plugin, stations):
    p, fake = plugin
    payload = _call(p, {"action": "play", "id": "somafm-groovesalad"})
    assert payload["ok"] is True
    assert fake.audio[0]["url"] == "https://ice1.somafm.com/groovesalad-128-mp3"
    assert fake.audio[0]["label"] == "SomaFM Groove Salad"


def test_play_refuses_a_private_url(plugin):
    p, fake = plugin
    payload = _call(p, {"action": "play", "url": "http://127.0.0.1:8080/radio.mp3"})
    assert payload["ok"] is False
    assert "public" in payload["error"]
    assert fake.audio == [], "nothing may reach the desktop for a refused URL"


def test_play_needs_a_url_or_id(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "play"})
    assert payload["ok"] is False
    assert "url" in payload["error"]


# ---------------------------------------------------------------------------
# stop / volume / video mute
# ---------------------------------------------------------------------------

def test_stop_publishes_a_stop(plugin):
    p, fake = plugin
    payload = _call(p, {"action": "stop"})
    assert payload["ok"] is True
    assert payload["playing"] is False
    assert fake.audio[0]["action"] == "stop"


def test_volume_accepts_0_to_1_and_rejects_the_rest(plugin):
    p, fake = plugin
    assert _call(p, {"action": "volume", "volume": 0.3})["volume"] == 0.3
    assert fake.audio[-1]["action"] == "volume"
    assert fake.audio[-1]["value"] == 0.3
    for bad in (1.5, -0.1, "loud", True, None):
        payload = _call(p, {"action": "volume", "volume": bad})
        assert payload["ok"] is False, bad


def test_mute_and_unmute_video_are_their_own_actions(plugin):
    p, fake = plugin
    assert _call(p, {"action": "mute_video"})["video_muted"] is True
    assert fake.audio[-1]["action"] == "mute_video"
    assert _call(p, {"action": "unmute_video"})["video_muted"] is False
    assert fake.audio[-1]["action"] == "unmute_video"
    # Muting the film must not be expressed as stopping the music.
    assert all(frame["action"] != "stop" for frame in fake.audio)


# ---------------------------------------------------------------------------
# honesty
# ---------------------------------------------------------------------------

def test_unknown_action_is_rejected(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "dance"})
    assert payload["ok"] is False
    assert "allowed_actions" in payload


def test_non_dict_arguments_answer_instead_of_crashing(plugin):
    p, _ = plugin
    for args in (None, [], "play", 7):
        payload = _call(p, args)
        assert payload["ok"] is False


def test_tool_never_raises_when_the_radio_module_breaks(plugin, monkeypatch):
    p, fake = plugin

    def explode(*args, **kwargs):
        raise RuntimeError("all broken")

    monkeypatch.setattr(p._radio, "search", explode)
    payload = _call(p, {"action": "search_radio", "q": "jazz"})
    assert payload["ok"] is False
    assert "RuntimeError" in payload["error"]

    monkeypatch.setattr(p, "_publish_audio", explode)
    payload = _call(p, {"action": "stop"})
    assert payload["ok"] is False
