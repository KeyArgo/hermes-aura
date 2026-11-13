"""aura_watch tests — the numbered-choice flow, the load command, "what's on",
URL validation and honest degradation.

No network: YouTube is answered from a fixture (``tests/test_search.py`` owns the
parser) or replaced at the module, and the server HTTP layer is a recorder. The
server-down path is real: no port, no socket, ``_request`` raises inside.

Run: .venv/bin/python -m pytest tests/test_watch_tool.py -q
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_plugin():
    name = "aura_watch_plugin"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROWS = [
    {"kind": "video", "id": "3GB-7qwwIp0",
     "url": "https://www.youtube.com/watch?v=3GB-7qwwIp0",
     "title": "Secrets of the Octopus", "channel": "Nat Geo Animals",
     "length": "2:03:39", "views": "2,946,453 views"},
    {"kind": "playlist", "id": "PLabcdefghijklmnopqrstuvwxyz012345",
     "url": "https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuvwxyz012345",
     "title": "Full octopus documentaries", "channel": "Timely Documentaries",
     "length": "8 videos", "views": "54,332 views"},
    {"kind": "video", "id": "ah8U0-fV6k8",
     "url": "https://www.youtube.com/watch?v=ah8U0-fV6k8",
     "title": "Masterminds: Secrets of the Octopus", "channel": "National Geographic",
     "length": "42:32", "views": "2.1M views"},
]


class FakeServer:
    """Port only; it never opens a socket. ``publish_*`` are no-ops."""

    def __init__(self, port=None):
        self.port = port
        self.ensures = 0

    def ensure_server(self):
        self.ensures += 1

    def get_port(self):
        return self.port

    def publish_mood(self, *args):
        pass

    def publish_config(self):
        pass

    def stop_server(self):
        pass


class Recorder:
    """Stands in for ``_request``; records every call the tool makes."""

    def __init__(self, player=None):
        self.calls = []
        self.commands = []
        self.player = player or {}

    def __call__(self, method, path, body=None, timeout=2.0):
        self.calls.append((method, path, body))
        if method == "POST" and path == "/api/player/command":
            self.commands.append(body)
            return {"ok": True, "seq": len(self.commands)}
        if path == "/api/player":
            return {"ok": True, "player": self.player, "seq": 7}
        return {}


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
def results(monkeypatch, plugin):
    p, _ = plugin
    seen = []

    def fake_search(query, limit=6):
        seen.append((query, limit))
        return [dict(row) for row in ROWS[:limit]]

    monkeypatch.setattr(p._search, "youtube_search", fake_search)
    return seen


@pytest.fixture()
def online(plugin, monkeypatch):
    p, fake = plugin
    fake.port = 45999
    recorder = Recorder(player={"url": "https://www.youtube.com/watch?v=3GB-7qwwIp0",
                                "label": "Secrets of the Octopus", "playing": True,
                                "position": 12.0, "duration": 7419.0})
    monkeypatch.setattr(p, "_request", recorder)
    return recorder


def _call(p, args):
    raw = p._tool_aura_watch(args)
    assert isinstance(raw, str)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# schema + registration
# ---------------------------------------------------------------------------

def test_schema_is_valid_and_unmissable(plugin):
    p, _ = plugin
    schema = p.SCHEMA_AURA_WATCH
    assert schema["name"] == "aura_watch"
    params = schema["parameters"]
    assert params["required"] == ["action"]
    assert params["properties"]["action"]["enum"] == ["search", "play", "now"]
    description = schema["description"].lower()
    for phrase in ("action=search", "numbered", "stop", "wait", "action=play",
                   "action=now", "title, channel, length and link"):
        assert phrase in description, f"the description must say {phrase!r}"
    assert "web search" in description and ".mp4" in description
    json.dumps(schema)


def test_third_tool_registers_in_the_aura_toolset(plugin):
    p, _ = plugin
    ctx = type("Ctx", (), {
        "tools": [],
        "hooks": [],
        "get_config": lambda self, key, default=None: default,
        "register_tool": lambda self, **kw: self.tools.append(kw),
        "register_hook": lambda self, name, fn: self.hooks.append((name, fn)),
    })()
    p.register(ctx)
    assert [tool["name"] for tool in ctx.tools] == [
        "aura_control", "aura_listen", "aura_watch"]


def test_plugin_yaml_declares_the_tool():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    assert "  - aura_watch" in text


# ---------------------------------------------------------------------------
# search — numbered options, and nothing plays
# ---------------------------------------------------------------------------

def test_search_returns_a_numbered_list_with_every_fact(plugin, results, online):
    p, _ = plugin
    payload = _call(p, {"action": "search", "q": "documentary about octopuses", "limit": 3})
    assert payload["ok"] is True
    assert payload["count"] == 3
    assert [item["n"] for item in payload["items"]] == [1, 2, 3]
    first = payload["items"][0]
    assert first["title"] == "Secrets of the Octopus"
    assert first["channel"] == "Nat Geo Animals"
    assert first["length"] == "2:03:39"
    assert first["url"] == "https://www.youtube.com/watch?v=3GB-7qwwIp0"
    lines = payload["text"].splitlines()
    assert lines[0].startswith("1. Secrets of the Octopus · Nat Geo Animals · 2:03:39 · ")
    assert "https://www.youtube.com/watch?v=3GB-7qwwIp0" in lines[0]
    assert lines[1].startswith("2. Full octopus documentaries · Timely Documentaries · 8 videos")
    assert "WAIT" in payload["next"] and "action=play" in payload["next"]
    assert results == [("documentary about octopuses", 3)]
    # Searching must never load anything, even with a live server.
    assert online.calls == [], "search must not touch the server"


def test_search_defaults_to_six_and_clamps(plugin, results):
    p, _ = plugin
    _call(p, {"action": "search", "q": "octopus"})
    assert results[-1] == ("octopus", 6)
    _call(p, {"action": "search", "q": "octopus", "limit": 999})
    assert results[-1] == ("octopus", 10)
    _call(p, {"action": "search", "q": "octopus", "limit": 0})
    assert results[-1] == ("octopus", 6)  # 0 means "default", same as the listen tool
    _call(p, {"action": "search", "q": "octopus", "limit": "nope"})
    assert results[-1] == ("octopus", 6)


def test_search_accepts_query_alias(plugin, results):
    p, _ = plugin
    payload = _call(p, {"action": "search", "query": "octopus"})
    assert payload["ok"] is True
    assert results[-1][0] == "octopus"


def test_search_with_nothing_found_is_honest(plugin, monkeypatch):
    p, _ = plugin
    monkeypatch.setattr(p._search, "youtube_search", lambda q, limit=6: [])
    payload = _call(p, {"action": "search", "q": "octopus"})
    assert payload["ok"] is False
    assert payload["error"] == "no_results"
    assert payload["items"] == []
    assert "unreachable" in payload["hint"]
    assert "action=play" in payload["hint"]


@pytest.mark.parametrize("query", ["", "   ", None, 7, [], {}])
def test_search_rejects_bad_queries_without_calling_out(plugin, monkeypatch, query):
    p, _ = plugin

    def explode(*args, **kwargs):
        raise AssertionError("must not search without a query")

    monkeypatch.setattr(p._search, "youtube_search", explode)
    payload = _call(p, {"action": "search", "q": query})
    assert payload["ok"] is False
    assert payload["allowed_actions"] == ["search", "play", "now"]


def test_search_reports_a_broken_search_module(plugin, monkeypatch):
    p, _ = plugin
    monkeypatch.setattr(p, "_search", None)
    payload = _call(p, {"action": "search", "q": "octopus"})
    assert payload["ok"] is False
    assert "unavailable" in payload["error"]


# ---------------------------------------------------------------------------
# play — one load command, nothing else
# ---------------------------------------------------------------------------

def test_play_queues_exactly_one_load(plugin, online):
    p, _ = plugin
    payload = _call(p, {"action": "play",
                        "url": "https://www.youtube.com/watch?v=3GB-7qwwIp0",
                        "label": "Secrets of the Octopus"})
    assert payload["ok"] is True
    assert payload["playing"] is True
    assert payload["seq"] == 1
    assert payload["kind"] == "youtube"
    assert online.commands == [{
        "cmd": "load",
        "url": "https://www.youtube.com/watch?v=3GB-7qwwIp0",
        "label": "Secrets of the Octopus",
    }]
    assert [call[:2] for call in online.calls].count(
        ("POST", "/api/player/command")) == 1


def test_play_normalises_a_share_link(plugin, online):
    p, _ = plugin
    payload = _call(p, {"action": "play", "url": "https://youtu.be/3GB-7qwwIp0"})
    assert payload["ok"] is True
    assert online.commands[-1]["url"] == "https://www.youtube.com/watch?v=3GB-7qwwIp0"
    # No label given: the url is the honest label.
    assert online.commands[-1]["label"] == "https://www.youtube.com/watch?v=3GB-7qwwIp0"


def test_play_accepts_a_direct_media_file(plugin, online):
    p, _ = plugin
    payload = _call(p, {"action": "play", "url": "https://example.org/octopus.webm",
                        "label": "Octopus (local copy)"})
    assert payload["ok"] is True
    assert payload["kind"] == "direct"
    assert online.commands[-1]["url"] == "https://example.org/octopus.webm"


def test_play_accepts_a_playlist(plugin, online):
    p, _ = plugin
    payload = _call(p, {
        "action": "play",
        "url": "https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuvwxyz012345",
        "label": "Full octopus documentaries",
    })
    assert payload["ok"] is True
    assert payload["kind"] == "youtube"
    assert online.commands[-1]["label"] == "Full octopus documentaries"


@pytest.mark.parametrize("url", [
    "",
    "   ",
    None,
    7,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.org/film.mp4",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch?v=too-short",
    "https://example.org/podcast.mp3",
    "not a url",
])
def test_play_refuses_unplayable_urls_without_touching_the_server(plugin, online, url):
    p, _ = plugin
    payload = _call(p, {"action": "play", "url": url})
    assert payload["ok"] is False
    assert payload["error"]
    assert online.commands == [], f"{url!r} must never reach the player"


def test_play_says_the_server_is_not_running(plugin):
    p, fake = plugin
    fake.port = None  # real _request: raises "server not running", no socket opened
    payload = _call(p, {"action": "play", "url": "https://youtu.be/3GB-7qwwIp0"})
    assert payload["ok"] is False
    assert "server not running" in payload["error"]
    assert "first use" in payload["hint"]
    assert "aura_control action=on" in payload["hint"]
    # Aura is started on first use, so the tool tried to start it.
    assert fake.ensures >= 1


def test_play_reports_a_rejected_command(plugin, monkeypatch):
    p, fake = plugin
    fake.port = 45999

    def reject(method, path, body=None, timeout=2.0):
        return {"ok": False, "error": "load needs a url"}

    monkeypatch.setattr(p, "_request", reject)
    payload = _call(p, {"action": "play", "url": "https://youtu.be/3GB-7qwwIp0"})
    assert payload["ok"] is False
    assert payload["error"] == "load needs a url"
    assert payload["command"] == "load"


# ---------------------------------------------------------------------------
# now — what is playing
# ---------------------------------------------------------------------------

def test_now_reports_the_player(plugin, online):
    p, _ = plugin
    payload = _call(p, {"action": "now"})
    assert payload["ok"] is True
    assert payload["running"] is True
    assert payload["playing"] is True
    assert payload["player"]["label"] == "Secrets of the Octopus"
    assert payload["command_seq"] == 7
    assert online.commands == []


def test_now_says_nothing_is_loaded_yet(plugin, online):
    p, _ = plugin
    online.player = {}
    payload = _call(p, {"action": "now"})
    assert payload["ok"] is True
    assert payload["playing"] is False
    assert "nothing is loaded" in payload["hint"]


def test_now_says_the_server_is_not_running(plugin):
    p, fake = plugin
    fake.port = None
    payload = _call(p, {"action": "now"})
    assert payload["ok"] is False
    assert payload["running"] is False
    assert "first use" in payload["hint"]


# ---------------------------------------------------------------------------
# honesty
# ---------------------------------------------------------------------------

def test_default_action_is_search(plugin, results):
    p, _ = plugin
    payload = _call(p, {"q": "octopus"})
    assert payload["ok"] is True
    assert payload["count"] == 3


def test_unknown_action_is_rejected(plugin):
    p, _ = plugin
    payload = _call(p, {"action": "download"})
    assert payload["ok"] is False
    assert payload["allowed_actions"] == ["search", "play", "now"]


@pytest.mark.parametrize("args", [None, [], "play", 7])
def test_non_dict_arguments_answer_instead_of_crashing(plugin, args):
    p, _ = plugin
    payload = _call(p, args)
    assert payload["ok"] is False


def test_tool_never_raises_when_the_player_layer_breaks(plugin, monkeypatch):
    p, fake = plugin
    fake.port = 45999

    def explode(*args, **kwargs):
        raise RuntimeError("all broken")

    monkeypatch.setattr(p, "_player_snapshot", explode)
    payload = _call(p, {"action": "now"})
    assert payload["ok"] is False
    assert "RuntimeError" in payload["error"]


# ---------------------------------------------------------------------------
# dashboard GET /search (payload builder; fastapi is stubbed, nothing served)
# ---------------------------------------------------------------------------

@pytest.fixture()
def dashboard():
    routes = []

    class Router:
        def _record(self, method):
            def decorator(path):
                def register(fn):
                    routes.append((method, path, fn))
                    return fn
                return register
            return decorator

        def get(self, path):
            return self._record("GET")(path)

        def post(self, path):
            return self._record("POST")(path)

        def delete(self, path):
            return self._record("DELETE")(path)

    fake = types.ModuleType("fastapi")
    fake.APIRouter = Router
    fake.Request = object
    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = lambda payload, status_code=200: (status_code, payload)
    fake.responses = responses
    sys.modules["fastapi"] = fake
    sys.modules["fastapi.responses"] = responses
    try:
        sys.modules.pop("dashboard.plugin_api", None)
        import importlib
        module = importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)
    module.__dict__["_WATCH_ROUTES"] = routes
    return module


def test_dashboard_registers_get_search(dashboard):
    seen = {(method, path) for method, path, _ in dashboard._WATCH_ROUTES}
    assert ("GET", "/search") in seen


def test_dashboard_search_returns_items(dashboard, monkeypatch):
    from aura_core import search
    monkeypatch.setattr(search, "youtube_search", lambda q, limit=6: ROWS[:limit])
    payload = dashboard.search_payload("octopus documentary", 2)
    assert payload["ok"] is True
    assert payload["count"] == 2
    assert payload["items"][0]["title"] == "Secrets of the Octopus"


def test_dashboard_search_outage_is_an_empty_list(dashboard, monkeypatch):
    from aura_core import search

    def offline(q, limit=6):
        return []

    monkeypatch.setattr(search, "youtube_search", offline)
    payload = dashboard.search_payload("octopus", 6)
    assert payload["ok"] is True
    assert payload["items"] == []
    assert "unreachable" in payload["note"]


def test_dashboard_search_survives_a_broken_module(dashboard, monkeypatch):
    from aura_core import search

    def explode(q, limit=6):
        raise RuntimeError("boom")

    monkeypatch.setattr(search, "youtube_search", explode)
    payload = dashboard.search_payload("octopus", 6)
    assert payload["ok"] is False
    assert payload["error"] == "search_failed"
    assert payload["items"] == []
