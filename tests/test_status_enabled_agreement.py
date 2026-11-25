"""Aura on/off must read the same from the dashboard and from the server.

The desktop half only places its stage when ``/status`` says ``enabled: true``
(``desktop/plugin.js``: ``live.ok ? live.enabled === true : settings.enabled``),
so a dashboard that answers "off" for a server running on with the defaults
removes a stage the user never switched off. A missing ``aura/config.json`` and
one holding ``{}`` are both "nothing saved yet": the server answers the
defaults, and the default is on. A saved "off" must still read off on both
sides.

Each case runs the real dashboard payload builder against a real in-process
server, and compares it with what that server reports on ``/api/state``.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aura_core import server  # noqa: E402


@pytest.fixture()
def dashboard():
    """Import dashboard/plugin_api.py with a tiny fastapi stand-in."""

    class Router:
        def _record(self, method):
            def decorator(path):
                return lambda fn: fn
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
        return importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")  # deterministic: no real audio
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        server.stop_server()


def _server_says(live) -> bool:
    """``enabled`` straight from the running server's /api/state."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{live['port']}/api/state",
        headers={"Authorization": f"Bearer {live['token']}"},
    )
    with urllib.request.urlopen(req, timeout=2.0) as resp:
        return bool(json.loads(resp.read().decode("utf-8"))["enabled"])


def _write_config(live, text: str) -> None:
    path = Path(live["home"]) / "aura" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.mark.parametrize("saved", [None, "{}"], ids=["missing-config", "empty-object"])
def test_status_agrees_with_the_server_when_nothing_is_saved(dashboard, live, saved):
    if saved is not None:
        _write_config(live, saved)

    server_enabled = _server_says(live)
    status = dashboard.status_payload()

    assert status["ok"] is True
    # The server runs the defaults, and the default is on.
    assert server_enabled is True
    # /status must say the same, or the desktop drops the stage with no click.
    assert status["enabled"] == server_enabled


def test_status_agrees_with_the_server_on_a_saved_off(dashboard, live):
    _write_config(live, json.dumps({"enabled": False}))

    server_enabled = _server_says(live)
    status = dashboard.status_payload()

    assert server_enabled is False
    assert status["enabled"] is False
