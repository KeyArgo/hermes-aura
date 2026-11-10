"""Hook glue tests — CONTRACT.md §4/§7.

The server is always stubbed: no live server, no sockets.  Every handler must
be an observer (return None, never raise) and must publish the right mood.
"""

from __future__ import annotations

import importlib.util
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
        self.stops = 0

    def ensure_server(self):
        self.ensures += 1

    def get_port(self):
        return self.port

    def publish_mood(self, mood, intensity, ttl_ms):
        self.moods.append((mood, intensity, ttl_ms))

    def publish_config(self):
        self.config_publishes += 1

    def stop_server(self):
        self.stops += 1


class FakeCtx:
    def __init__(self, config=None):
        self.config = dict(config or {})
        self.tools = []
        self.hooks = []

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def set_config(self, key, value):
        self.config[key] = value

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)

    def register_hook(self, name, fn):
        self.hooks.append((name, fn))


@pytest.fixture
def plugin(monkeypatch):
    p = _load_plugin()
    clock = FakeClock()
    monkeypatch.setattr(p, "_MACHINE", p._mood.MoodMachine(clock=clock))
    fake = FakeServer()
    monkeypatch.setattr(p, "_server", fake)
    p._CFG.enabled = True
    p._CTX = None
    return p, fake, clock


def _last(fake):
    assert fake.moods, "no mood was published"
    return fake.moods[-1]


# ---------------------------------------------------------------------------
# registration surface
# ---------------------------------------------------------------------------

PLUGIN_YAML_HOOKS = [
    "on_session_start",
    "on_session_end",
    "pre_tool_call",
    "post_tool_call",
    "pre_approval_request",
    "post_approval_response",
    "api_request_error",
    "on_stream_start",
    "on_stream_end",
    "subagent_start",
    "subagent_stop",
]


def test_hooks_match_plugin_yaml(plugin):
    p, _, _ = plugin
    assert [name for name, _ in p.HOOKS] == PLUGIN_YAML_HOOKS


def test_register_registers_tool_and_hooks(plugin):
    p, _, _ = plugin
    ctx = FakeCtx()
    p.register(ctx)
    assert [hook for hook, _ in ctx.hooks] == PLUGIN_YAML_HOOKS
    # [listen lane] aura_listen joined aura_control in the aura toolset.
    # [watch lane] aura_watch adds the "find me something to watch" flow.
    assert len(ctx.tools) == 3
    assert [tool["name"] for tool in ctx.tools] == [
        "aura_control", "aura_listen", "aura_watch"]
    assert all(tool["toolset"] == "aura" for tool in ctx.tools)


def test_register_honours_disabled_config(plugin):
    p, fake, _ = plugin
    ctx = FakeCtx({"enabled": False})
    p.register(ctx)
    assert p._CFG.enabled is False
    assert p._hook_pre_tool_call(tool_name="bash", args={}) is None
    assert fake.moods == []


# ---------------------------------------------------------------------------
# hook payload -> mood mapping
# ---------------------------------------------------------------------------

def test_session_start_resets_to_idle(plugin):
    p, fake, _ = plugin
    p._MACHINE.set("tool")
    assert p._hook_session_start(session_id="s1", session_key="k") is None
    mood, intensity, ttl = _last(fake)
    assert mood == "idle"
    assert intensity == 0.0
    assert ttl == 0
    assert p._MACHINE.snapshot().mood == "idle"


def test_session_end_returns_to_idle(plugin):
    p, fake, _ = plugin
    p._MACHINE.set("streaming")
    assert p._hook_session_end(session_id="s1") is None
    assert _last(fake)[0] == "idle"


def test_pre_tool_call_is_tool(plugin):
    p, fake, _ = plugin
    payload = {"tool_name": "bash", "args": {"command": "ls"}, "session_id": "s1"}
    assert p._hook_pre_tool_call(**payload) is None
    mood, intensity, ttl = _last(fake)
    assert mood == "tool"
    assert 0.0 <= intensity <= 1.0
    assert ttl > 0


def test_post_tool_call_success_is_thinking(plugin):
    p, fake, _ = plugin
    payload = {"tool_name": "read_file", "status": "ok", "error_message": None}
    assert p._hook_post_tool_call(**payload) is None
    assert _last(fake)[0] == "thinking"


def test_post_tool_call_failure_is_error(plugin):
    p, fake, _ = plugin
    payload = {"tool_name": "bash", "error_message": "boom", "status": "error"}
    assert p._hook_post_tool_call(**payload) is None
    mood, intensity, ttl = _last(fake)
    assert mood == "error"
    assert intensity >= 0.6
    assert ttl > 0


def test_pre_approval_request_is_approval(plugin):
    p, fake, _ = plugin
    payload = {"command": "rm -rf /tmp/x", "description": "delete tmp",
               "pattern_key": "rm", "session_key": "k", "surface": "cli"}
    assert p._hook_pre_approval_request(**payload) is None
    mood, intensity, ttl = _last(fake)
    assert mood == "approval"
    assert intensity >= 0.6
    assert 0 < ttl <= 60_000


def test_post_approval_response_restores_previous_mood(plugin):
    p, fake, _ = plugin
    p._hook_pre_tool_call(tool_name="bash", args={})
    p._hook_pre_approval_request(command="ls", surface="cli")
    assert p._hook_post_approval_response(choice="allow", session_key="k") is None
    assert _last(fake)[0] == "tool"
    assert p._MACHINE.snapshot().mood == "tool"


def test_post_approval_response_without_approval_is_noop(plugin):
    p, fake, _ = plugin
    p._hook_pre_tool_call(tool_name="bash", args={})
    fake.moods.clear()
    assert p._hook_post_approval_response(choice="deny") is None
    assert fake.moods == []
    assert p._MACHINE.snapshot().mood == "tool"


def test_api_request_error_is_error(plugin):
    p, fake, _ = plugin
    payload = {"provider": "openai", "model": "m", "status_code": 500,
               "error_type": "server_error", "error_message": "oops"}
    assert p._hook_api_request_error(**payload) is None
    mood, intensity, ttl = _last(fake)
    assert mood == "error"
    assert intensity >= 0.6
    assert ttl > 0


def test_stream_start_is_streaming(plugin):
    p, fake, _ = plugin
    assert p._hook_on_stream_start(session_id="s1") is None
    assert _last(fake)[0] == "streaming"


def test_stream_end_is_done_and_settles(plugin, monkeypatch):
    p, fake, clock = plugin
    assert p._hook_on_stream_end(session_id="s1") is None
    mood, intensity, ttl = _last(fake)
    assert mood == "done"
    assert 0 < ttl <= 1500
    clock.advance(1500)
    assert p._MACHINE.tick().mood == "idle"


def test_subagent_start_is_thinking(plugin):
    p, fake, _ = plugin
    assert p._hook_subagent_start(subagent_id="a1") is None
    assert _last(fake)[0] == "thinking"


def test_subagent_stop_is_thinking(plugin):
    p, fake, _ = plugin
    assert p._hook_subagent_stop(subagent_id="a1", status="done") is None
    assert _last(fake)[0] == "thinking"


# ---------------------------------------------------------------------------
# observer guarantees
# ---------------------------------------------------------------------------

JUNK_PAYLOADS = [
    {},
    {"args": object(), "tool_name": None},
    {"error_message": object(), "status": object()},
    {"command": None, "description": None, "pattern_key": object(),
     "session_key": None, "surface": object()},
    {"provider": None, "model": [], "status_code": "nope",
     "error_type": {"a": 1}, "error_message": 42},
    {"session_id": {"nested": True}},
]


@pytest.mark.parametrize("payload", JUNK_PAYLOADS)
def test_handlers_never_raise_on_junk(plugin, payload):
    p, _, _ = plugin
    for _name, fn in p.HOOKS:
        assert fn(**payload) is None


def test_handler_returns_none_never_a_dict(plugin):
    p, _, _ = plugin
    results = [
        p._hook_session_start(session_id="s"),
        p._hook_session_end(),
        p._hook_pre_tool_call(tool_name="bash", args={}),
        p._hook_post_tool_call(tool_name="bash", status="ok"),
        p._hook_pre_approval_request(command="ls"),
        p._hook_post_approval_response(choice="allow"),
        p._hook_api_request_error(status_code=500),
        p._hook_on_stream_start(),
        p._hook_on_stream_end(),
        p._hook_subagent_start(),
        p._hook_subagent_stop(),
    ]
    assert all(result is None for result in results)


def test_publish_failure_is_swallowed(plugin):
    p, fake, _ = plugin

    def explode(*args, **kwargs):
        raise RuntimeError("socket closed")

    fake.publish_mood = explode
    assert p._hook_pre_tool_call(tool_name="bash", args={}) is None
    assert p._hook_post_approval_response(choice="allow") is None


def test_disabled_kill_switch_makes_every_hook_noop(plugin):
    p, fake, _ = plugin
    p._MACHINE.set("tool")
    p._set_enabled(False)
    assert p._MACHINE.snapshot().mood == "idle"
    fake.moods.clear()
    for _name, fn in p.HOOKS:
        assert fn(tool_name="bash", status="ok") is None
    assert fake.moods == []


def test_reenable_starts_idle(plugin):
    p, fake, _ = plugin
    p._set_enabled(False)
    p._MACHINE.set("error")
    p._set_enabled(True)
    assert p._MACHINE.snapshot().mood == "idle"
