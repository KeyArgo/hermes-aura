"""A follower's ``/status`` sees capture that only became available after start.

The lease is how another process (the dashboard, the CLI, the tools) learns which
backend the leader is capturing, and it was advertised once at start. A leader
that came up before its audio device existed advertised ``capture: "none"``; when
the device appeared the capture loop swapped in a real backend and updated its
own live state, but lease maintenance compared only pid, port and token, so the
file kept saying ``none``. A dashboard running as a follower reads the lease, so
it showed the no-capture hint for as long as the leader lived while the
visualizer reacted to real audio.

``test_lease_reassert.py`` covers a lease overwritten by another writer and
``test_capture_recovery.py`` covers the page's view inside the leader; neither
looks at what a follower process is told.

Run: pytest tests/test_lease_capture_name.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aura_core import config
from aura_core import server
from aura_core.capture import base as capture

ROOT = Path(__file__).resolve().parent.parent

# A separate process asks the /status door the way the dashboard does: same
# module, same stub fastapi the dashboard tests use, so this is the real body.
FOLLOWER = r'''
import json
import sys
import types

sys.path.insert(0, sys.argv[1])


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


fastapi = types.ModuleType("fastapi")
fastapi.APIRouter = Router
fastapi.Request = object
responses = types.ModuleType("fastapi.responses")
responses.JSONResponse = lambda payload, status_code=200: payload
fastapi.responses = responses
sys.modules["fastapi"] = fastapi
sys.modules["fastapi.responses"] = responses

from dashboard import plugin_api

print(json.dumps(plugin_api.status_payload()))
'''


class FakeCapture:
    """Minimal backend standing in for the device that shows up late."""

    def __init__(self, name: str = "pulse"):
        self.name = name
        self.closed = False

    def read(self, n: int = capture.FRAME_SAMPLES) -> bytes:
        time.sleep(capture.FRAME_SAMPLES / capture.SAMPLE_RATE)
        return b"\x00" * (n * 4)

    def close(self) -> None:
        self.closed = True


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture()
def leader(tmp_path, monkeypatch):
    """A live leader whose audio device is missing at start and arrives after."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_CAPTURE", raising=False)  # the retry probe only runs unpinned
    monkeypatch.setattr(server, "LEASE_CHECK_S", 0.2, raising=False)
    monkeypatch.setattr(server, "CAPTURE_RETRY_S", 0.2, raising=False)

    device = {"ready": False}

    def open_capture(preferred=None):
        if not device["ready"]:
            raise RuntimeError("no audio device yet")
        return FakeCapture()

    monkeypatch.setattr(capture, "open_capture", open_capture)
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"home": tmp_path, "device": device}
    finally:
        server.stop_server()


def _follower_status(home: Path) -> dict:
    env = dict(os.environ)
    env["HERMES_HOME"] = str(home)
    env.pop("AURA_CAPTURE", None)
    out = subprocess.run(
        [sys.executable, "-c", FOLLOWER, str(ROOT)],
        cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=60, check=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_follower_status_follows_capture_that_arrived_after_the_lease(leader):
    lease = config.read_lease() or {}
    assert lease.get("capture") == "none", f"the leader did not start on silence: {lease}"

    leader["device"]["ready"] = True  # the device is connected
    assert _wait_for(lambda: server.get_capture() == "pulse"), \
        "the leader never recovered a real capture backend"

    server._reassert_lease()  # one lease maintenance pass

    status = _follower_status(leader["home"])
    assert status["ok"] is True, status
    assert status["capture"] == "pulse", \
        f"a follower still reports no capture while the leader captures audio: {status}"

    assert (config.read_lease() or {}).get("capture") == "pulse", \
        "the lease still advertises the capture name from start"
