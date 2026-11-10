"""aura_control tool tests — schema, actions, redaction, graceful degradation.

The server is stubbed: ``get_port``/``ensure_server``/``publish_mood`` are fake
and HTTP is monkeypatched.  No live server is required.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_plugin():
    name = "aura_plugin"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class FakeClock:
    def __init__(self, seconds: float = 1000.0):
        self.seconds = seconds

    def __call__(self) -> float:
        return self.seconds

    def advance(self, ms: int) -> None:
        self.seconds += ms / 1000.0


class FakeServer:
    def __init__(self, port=None):
        self.port = port
        self.moods = []
        self.config_publishes = 0
        self.ensures = 0

    def ensure_server(self):
        self.ensures += 1

    def get_port(self):
        return self.port

    def publish_mood(self, mood, intensity, ttl_ms):
        self.moods.append((mood, intensity, ttl_ms))

    def publish_config(self):
        self.config_publishes += 1

    def stop_server(self):
        pass


class FakeHTTP:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = responses or {}

    def __call__(self, method, path, body=None, timeout=2.0):
        self.calls.append((method, path, body))
        if path in self.responses:
            return self.responses[path]
        if path == "/healthz":
            return {"ok": True, "version": "0.1.0", "pid": 1,
                    "capture": "pipewire", "rate": 48000, "clients": 1}
        if path == "/api/state":
            return {"enabled": True, "mood": "idle", "intensity": 0.4,
                    "preset": None}
        if path == "/api/control":
            return {"ok": True, "applied": body or {}}
        return {}


SECRET = "s3cr3t-token-do-not-show-0123456789"


@pytest.fixture
def plugin(monkeypatch):
    p = _load_plugin()
    monkeypatch.setattr(p, "_MACHINE", p._mood.MoodMachine(clock=FakeClock()))
    fake = FakeServer(port=4567)
    monkeypatch.setattr(p, "_server", fake)
    monkeypatch.setattr(p, "_token", lambda: SECRET)
    p._CFG.enabled = True
    p._CTX = None
    return p, fake


def _call(p, args):
    raw = p._tool_aura_control(args)
    assert isinstance(raw, str)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------

def test_schema_is_valid_and_complete(plugin):
    p, _ = plugin
    schema = p.SCHEMA_AURA_CONTROL
    assert schema["name"] == "aura_control"
    assert schema["description"]
    params = schema["parameters"]
    assert params["type"] == "object"
    assert params["required"] == ["action"]
    props = params["properties"]
    assert props["action"]["enum"] == list(p._ACTIONS)
    assert {"pause", "resume", "next", "prev", "seek", "popout", "popin"} <= set(props["action"]["enum"])
    assert props["position"]["type"] == "number"
    assert props["url"]["type"] == "string"
    assert props["intensity"]["type"] == "number"
    assert props["intensity"]["minimum"] == 0.0
    assert props["intensity"]["maximum"] == 1.0
    assert props["mood"]["enum"] == list(p._mood.MOODS)
    assert "null" in props["preset"]["type"]
    json.dumps(schema)  # must be JSON-serializable


def test_tool_registered_in_aura_toolset(plugin):
    p, _ = plugin
    ctx = type("Ctx", (), {
        "tools": [],
        "hooks": [],
        "get_config": lambda self, key, default=None: default,
        "set_config": lambda self, key, value: None,
        "register_tool": lambda self, **kw: self.tools.append(kw),
        "register_hook": lambda self, name, fn: self.hooks.append((name, fn)),
    })()
    p.register(ctx)
    assert ctx.tools[0]["name"] == "aura_control"
    assert ctx.tools[0]["toolset"] == "aura"


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

def test_status_server_not_running(plugin, monkeypatch):
    p, fake = plugin
    fake.port = None
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "status"})
    assert payload["ok"] is False
    assert payload["running"] is False
    assert payload["port"] is None
    assert "not running" in payload["error"]
    assert payload["mood"] == "idle"
    assert http.calls == []  # never guesses a port / never calls HTTP


def test_status_running_has_fields_and_redacted_url(plugin, monkeypatch):
    p, fake = plugin
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "status"})
    assert payload["ok"] is True
    assert payload["running"] is True
    assert payload["port"] == 4567
    assert payload["capture"] == "pipewire"
    assert payload["mood"] == "idle"
    assert payload["intensity"] == 0.4
    assert "url" in payload
    assert SECRET not in json.dumps(payload)
    assert "token=s3cr" in payload["url"]
    assert payload["url"].startswith("http://127.0.0.1:4567/")


def test_status_survives_http_failure(plugin, monkeypatch):
    p, fake = plugin

    def boom(method, path, body=None, timeout=2.0):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(p, "_request", boom)
    payload = _call(p, {"action": "status"})
    assert payload["ok"] is True
    assert payload["port"] == 4567
    assert payload["capture"] == "none"


def test_status_without_token_has_no_token_param(plugin, monkeypatch):
    p, _ = plugin
    monkeypatch.setattr(p, "_token", lambda: None)
    monkeypatch.setattr(p, "_request", FakeHTTP())
    payload = _call(p, {"action": "status"})
    assert "token=" not in payload["url"]


# ---------------------------------------------------------------------------
# on / off
# ---------------------------------------------------------------------------

def test_action_on_enables_and_calls_control(plugin, monkeypatch):
    p, fake = plugin
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "on"})
    assert payload["ok"] is True
    assert payload["enabled"] is True
    assert fake.ensures >= 1
    assert ("POST", "/api/control", {"enabled": True}) in http.calls
    assert p._CFG.enabled is True


def test_action_off_disables_and_resets_mood(plugin, monkeypatch):
    p, fake = plugin
    p._MACHINE.set("tool")
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "off"})
    assert payload["ok"] is True
    assert payload["enabled"] is False
    assert ("POST", "/api/control", {"enabled": False}) in http.calls
    assert p._MACHINE.snapshot().mood == "idle"


def test_action_on_with_server_not_running_is_graceful(plugin):
    p, fake = plugin
    fake.port = None
    payload = _call(p, {"action": "on"})
    assert payload["ok"] is True
    assert payload["enabled"] is True
    assert payload["running"] is False
    assert "control_error" in payload
    assert "not running" in payload["control_error"]


# ---------------------------------------------------------------------------
# intensity / preset / mood
# ---------------------------------------------------------------------------

def test_action_intensity_applies(plugin, monkeypatch):
    p, fake = plugin
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "intensity", "intensity": 0.5})
    assert payload["ok"] is True
    assert payload["intensity"] == 0.5
    assert ("POST", "/api/control", {"intensity": 0.5}) in http.calls
    assert p._MACHINE.set("thinking", intensity=1.0).intensity <= 0.5


@pytest.mark.parametrize("value", [1.5, -0.1, "x", None, True])
def test_action_intensity_rejects_bad_values(plugin, value):
    p, _ = plugin
    payload = _call(p, {"action": "intensity", "intensity": value})
    assert payload["ok"] is False
    assert "intensity" in payload["error"]


def test_action_preset_applies(plugin, monkeypatch):
    p, _ = plugin
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "preset", "preset": "Nebula"})
    assert payload["ok"] is True
    assert payload["preset"] == "Nebula"
    assert ("POST", "/api/control", {"preset": "Nebula"}) in http.calls


def test_action_preset_null_resets(plugin, monkeypatch):
    p, _ = plugin
    http = FakeHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "preset", "preset": None})
    assert payload["ok"] is True
    assert payload["preset"] is None
    assert ("POST", "/api/control", {"preset": None}) in http.calls


def test_action_preset_rejects_non_string(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "preset", "preset": 7})
    assert payload["ok"] is False


def test_action_mood_sets_mood_and_publishes(plugin):
    p, fake = plugin
    payload = _call(p, {"action": "mood", "mood": "approval"})
    assert payload["ok"] is True
    assert payload["mood"] == "approval"
    assert payload["intensity"] >= 0.6
    assert payload["ttl_ms"] > 0
    assert fake.moods[-1][0] == "approval"
    assert p._MACHINE.snapshot().mood == "approval"


def test_action_mood_rejects_unknown(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "mood", "mood": "party"})
    assert payload["ok"] is False
    assert "allowed_moods" in payload


# ---------------------------------------------------------------------------
# robustness
# ---------------------------------------------------------------------------

def test_default_action_is_status(plugin, monkeypatch):
    p, _ = plugin
    monkeypatch.setattr(p, "_request", FakeHTTP())
    payload = _call(p, {})
    assert "port" in payload


@pytest.mark.parametrize("args", [None, "status", 42, ["status"]])
def test_non_dict_args_answer_instead_of_crashing(plugin, args):
    p, _ = plugin
    raw = p._tool_aura_control(args)
    payload = json.loads(raw)
    assert payload["ok"] is False
    assert "arguments" in payload["error"]


def test_unknown_action_is_rejected(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "explode"})
    assert payload["ok"] is False
    assert "allowed_actions" in payload


def test_tool_never_raises_when_everything_breaks(plugin, monkeypatch):
    p, fake = plugin

    def explode(*args, **kwargs):
        raise RuntimeError("all broken")

    monkeypatch.setattr(p, "_request", explode)
    fake.publish_mood = explode
    fake.ensure_server = explode
    for args in ({"action": "status"}, {"action": "on"},
                 {"action": "off"}, {"action": "mood", "mood": "error"}):
        payload = _call(p, args)
        assert isinstance(payload, dict)
        assert payload["ok"] is True  # local intent applied; control error reported


# ---------------------------------------------------------------------------
# the film: Hermes as the remote
# ---------------------------------------------------------------------------

class FilmHTTP:
    """Records calls and answers the film endpoints like the live server."""

    def __init__(self):
        self.calls = []
        self.seq = 0
        self.player = {"url": "https://example.test/film.mp4", "title": "Octopus",
                       "playing": True, "position": 30.0, "duration": 600.0}

    def __call__(self, method, path, body=None, timeout=2.0):
        self.calls.append((method, path, body))
        if path == "/api/player/command":
            self.seq += 1
            return {"ok": True, "seq": self.seq, "command": dict(body or {})}
        if path == "/api/player":
            return {"ok": True, "player": dict(self.player), "seq": self.seq,
                    "window": {"open": True, "available": True}}
        if path == "/api/window":
            return {"ok": True, "open": True, "available": True,
                    "url": self.player["url"], "pid": 99, "browser": "chromium"}
        if path == "/api/window/open":
            return {"ok": True, "open": True, "already": False,
                    "window": {"open": True, "available": True}}
        if path == "/api/window/close":
            return {"ok": True, "closed": True,
                    "window": {"open": False, "available": True}}
        return {}


@pytest.mark.parametrize("action,expected", [
    ("pause", "pause"), ("resume", "play"), ("next", "next"), ("prev", "prev"),
])
def test_transport_actions_queue_the_right_command(plugin, monkeypatch, action, expected):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": action})
    assert payload["ok"] is True
    assert payload["command"] == expected
    assert payload["seq"] == 1
    assert ("POST", "/api/player/command", {"cmd": expected}) in http.calls
    assert payload["player"]["title"] == "Octopus"
    assert payload["window"]["open"] is True


def test_seek_carries_an_absolute_position(plugin, monkeypatch):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "seek", "position": 125})
    assert payload["ok"] is True
    assert ("POST", "/api/player/command", {"cmd": "seek", "value": 125.0}) in http.calls


@pytest.mark.parametrize("value", [None, "120", True])
def test_seek_rejects_a_bad_position(plugin, value):
    p, _ = plugin
    payload = _call(p, {"action": "seek", "position": value})
    assert payload["ok"] is False
    assert "position" in payload["error"]


def test_transport_without_a_server_says_so(plugin):
    p, fake = plugin
    fake.port = None
    payload = _call(p, {"action": "pause"})
    assert payload["ok"] is False
    assert "not running" in payload["hint"]


def test_popout_opens_the_window(plugin, monkeypatch):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "popout", "url": "https://example.test/film.mp4",
                        "position": 42})
    assert payload["ok"] is True
    assert payload["open"] is True
    assert ("POST", "/api/window/open",
            {"url": "https://example.test/film.mp4", "position": 42.0}) in http.calls
    assert "window" in payload["hint"].lower() or "its own window" in payload["hint"]


def test_popout_without_a_url_uses_the_reported_film(plugin, monkeypatch):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "popout"})
    assert payload["ok"] is True
    assert ("POST", "/api/window/open", {}) in http.calls


def test_popin_closes_the_window(plugin, monkeypatch):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "popin"})
    assert payload["ok"] is True
    assert payload["closed"] is True
    assert ("POST", "/api/window/close", {}) in http.calls


def test_popout_reports_a_missing_browser(plugin, monkeypatch):
    p, _ = plugin

    def no_browser(method, path, body=None, timeout=2.0):
        if path == "/api/window/open":
            return {"ok": False, "error": "no Chrome or Chromium found",
                    "window": {"open": False, "available": False}}
        return {}

    monkeypatch.setattr(p, "_request", no_browser)
    payload = _call(p, {"action": "popout"})
    assert payload["ok"] is False
    assert "Chrome" in payload["error"]


def test_status_includes_the_film(plugin, monkeypatch):
    p, _ = plugin
    http = FilmHTTP()
    monkeypatch.setattr(p, "_request", http)
    payload = _call(p, {"action": "status"})
    assert payload["film"]["player"]["playing"] is True
    assert payload["film"]["window"]["open"] is True

