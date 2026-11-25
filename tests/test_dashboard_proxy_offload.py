"""A pop-out must not stall the dashboard's other requests.

``/window/open`` waits for the Aura server, and a fresh launch spends 1.5 s
there (``aura_core/window.py``: ``proc.wait(1.5)``) to learn Chromium stayed
up; a slow launch can hold the proxy's 15 s. The route is ``async``, so a
blocking forward called straight from it holds the event loop and every other
request on the same worker waits behind the pop-out.

Each case here holds a real upstream socket behind a barrier, starts the
pop-out, and requires an unrelated handler on the same worker to answer while
the barrier is still closed.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# How long the held upstream waits for the test to release it. The unrelated
# request must answer well inside this; on a stalled loop it only answers when
# the pop-out's forward returns.
BARRIER_WAIT = 2.0
UNRELATED_BUDGET = 0.5


@pytest.fixture()
def dashboard():
    """Import dashboard/plugin_api.py with a tiny fastapi stand-in."""

    class Router:
        def get(self, path):
            return lambda fn: fn

        def post(self, path):
            return lambda fn: fn

        def delete(self, path):
            return lambda fn: fn

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
        yield importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)
        sys.modules.pop("dashboard.plugin_api", None)


@pytest.fixture()
def upstream():
    """A real server whose answer stays held until the test releases it."""

    hit = threading.Event()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            hit.set()
            release.wait(BARRIER_WAIT)
            body = json.dumps({"ok": True, "open": True, "path": self.path}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_POST = _answer
        do_GET = _answer

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"port": httpd.server_address[1], "hit": hit, "release": release}
    finally:
        release.set()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


class _Body:
    """Minimal ``Request``: these routes only ``await request.json()``."""

    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


async def _another_request() -> bool:
    """Any other async handler on the worker: it needs one turn of the loop."""
    await asyncio.sleep(0)
    return True


async def _while_held(pop_out, release):
    """Answer an unrelated request while ``pop_out`` is in flight.

    Returns ``(answered, elapsed)``: whether the other handler ran at all, and
    how long its loop waited for a turn.
    """
    pending = asyncio.ensure_future(pop_out)
    started = time.monotonic()
    try:
        answered = await asyncio.wait_for(_another_request(), timeout=BARRIER_WAIT - 0.5)
    except asyncio.TimeoutError:
        answered = False
    elapsed = time.monotonic() - started
    release.set()
    status, payload = await asyncio.wait_for(pending, timeout=5)
    assert status == 200 and payload.get("open") is True, payload
    return answered, elapsed


CASES = [
    ("window_open", "/api/window/open", {"url": "https://example.test/film.mp4"}),
    ("window_close", "/api/window/close", None),
    ("window_manage", "/api/window/manage", {"url": "https://example.test/list"}),
]


@pytest.mark.parametrize("route,path,body", CASES, ids=[case[0] for case in CASES])
def test_a_held_pop_out_does_not_stall_another_request(
        dashboard, upstream, monkeypatch, route, path, body):
    monkeypatch.setattr(dashboard, "_live", lambda: (None, upstream["port"], "token"))
    request = None if body is None else _Body(body)
    call = getattr(dashboard, route)
    pop_out = call() if request is None else call(request)

    answered, elapsed = asyncio.run(_while_held(pop_out, upstream["release"]))

    assert upstream["hit"].is_set(), "the pop-out never reached the upstream"
    assert answered, f"{path} never let another request onto the loop"
    assert elapsed < UNRELATED_BUDGET, (
        f"{path} held the event loop for {elapsed:.2f}s: an unrelated request on "
        "the same worker only answered after the pop-out's forward returned"
    )


def test_the_offloaded_forward_keeps_the_request_profile(dashboard):
    """Hermes resolves the profile from a context variable. The worker thread
    a forward runs on has to see the request's profile, or a named profile's
    pop-out is sent to the default profile's Aura server."""
    import contextvars

    profile = contextvars.ContextVar("profile", default="default")

    async def request():
        profile.set("jester")
        return await dashboard._off_loop(profile.get)

    assert asyncio.run(request()) == "jester"
