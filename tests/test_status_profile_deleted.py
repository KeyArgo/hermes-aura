"""A dashboard status poll must not bring a deleted profile back.

The desktop polls ``/status`` under the profile its panel is open for. When the
user deletes that profile the lease watcher stops the server and drops the
leader lock, so the next poll still scoped to the gone home found itself "own
home", re-elected, and ``_ensure_dir()`` mkdir'd the profile folder back --
after which Hermes refuses the profile with "Named profile home does not
exist". ``test_lease_profile_deleted.py`` only asked ``get_port()``, which never
takes the dashboard's restart path.
"""

from __future__ import annotations

import importlib
import shutil
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from aura_core import server  # noqa: E402


@pytest.fixture()
def dashboard(tmp_path):
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
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.setattr(server, "LEASE_CHECK_S", 0.2, raising=False)
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    assert port, "server did not start"
    try:
        yield {"home": tmp_path, "port": port}
    finally:
        server.stop_server()


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_a_status_poll_does_not_recreate_a_deleted_profile(dashboard, live):
    shutil.rmtree(live["home"])
    assert not live["home"].exists()

    # The lease watcher notices the missing home and stops the server. Wait on
    # the server's own state, not get_port(): asking for a port is itself one of
    # the restart paths this test is about.
    assert _wait_for(lambda: not server._server_running(), timeout=5.0), \
        "the server kept serving after its profile home was deleted"

    first = dashboard.status_payload()
    second = dashboard.status_payload()

    assert not live["home"].exists(), "a status poll re-created the deleted profile home"
    assert first["port"] is None and second["port"] is None, \
        f"a status poll advertised a restarted server: {first} / {second}"
    assert first["ok"] is False and second["ok"] is False
