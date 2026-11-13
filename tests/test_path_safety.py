"""Path and argument containment on Aura's request surface.

Every value a request, a tool call or a fetched playlist can steer into a file
path, a served asset or a browser command line is exercised here: traversal,
absolute paths, symlinks, encoded dots, NUL bytes, and URLs whose scheme Aura
never serves. The tests are black-box where they can be (HTTP) so they describe
what a caller sees, not how the handler is written.
"""

from __future__ import annotations

import http.client
import importlib
import json
import socket
import sys
import types

import pytest

from aura_core import server
from aura_core import window as desktop_window


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------

@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        server.stop_server()


def call(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(data))
    conn.request(method, path, body=data, headers=headers)
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        payload = {}
    return response.status, payload


def raw_request(port, target: bytes, token: str) -> bytes:
    """Send a request line byte-for-byte: http.client refuses control characters."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        request = (b"GET " + target + b" HTTP/1.1\r\n"
                   + f"Host: 127.0.0.1:{port}\r\n".encode("ascii")
                   + f"Authorization: Bearer {token}\r\n".encode("ascii")
                   + b"Connection: close\r\n\r\n")
        sock.sendall(request)
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        sock.close()
    return b"".join(chunks).split(b"\r\n", 1)[0]


@pytest.fixture()
def dashboard():
    """Import dashboard/plugin_api.py with a tiny fastapi stand-in."""

    class Router:
        def _record(self, _method):
            def decorator(path):
                def register(fn):
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
        module = importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)
    return module


# ---------------------------------------------------------------------------
# static assets: nothing outside web/ may be served, and a hostile path is a
# refusal rather than an internal error
# ---------------------------------------------------------------------------

TRAVERSAL_TARGETS = (
    "/vendor/../../etc/passwd",
    "/vendor/%2e%2e/%2e%2e/etc/passwd",
    "/vendor/..%2f..%2fetc%2fpasswd",
    "/vendor/..\\..\\etc\\passwd",
    "/vendor/../aura_core/server.py",
    "/../aura_core/server.py",
    "//etc/passwd",
    "/vendor/sub/dir.js",
    "/etc/passwd",
)


def test_static_requests_never_reach_outside_the_web_directory(live):
    for target in TRAVERSAL_TARGETS:
        status, _ = call(live["port"], "GET", target, live["token"])
        assert status in (401, 404), (target, status)


def test_a_symlink_inside_web_cannot_escape_it(live, tmp_path, monkeypatch):
    web = tmp_path / "web"
    (web / "vendor").mkdir(parents=True)
    (web / "vendor" / "escape.js").symlink_to("/etc/passwd")
    (web / "vendor" / "real.js").write_text("// fine\n", encoding="utf-8")
    monkeypatch.setattr(server, "WEB_DIR", web)
    status, _ = call(live["port"], "GET", "/vendor/escape.js", live["token"])
    assert status == 404
    status, _ = call(live["port"], "GET", "/vendor/real.js", live["token"])
    assert status == 200


def test_a_null_byte_in_a_static_path_is_refused_not_an_internal_error(live):
    line = raw_request(live["port"], b"/vendor/aura\x00.js", live["token"])
    assert b"404" in line, line
    assert b"500" not in line, line


# ---------------------------------------------------------------------------
# the player command queue: a load is a URL the page will fetch and play
# ---------------------------------------------------------------------------

def test_load_refuses_a_scheme_the_page_must_never_load(live):
    for url in ("file:///etc/passwd", "ftp://example.test/a.mp4", "javascript:alert(1)"):
        status, payload = call(live["port"], "POST", "/api/player/command",
                               live["token"], {"cmd": "load", "url": url})
        assert status == 400, (url, status)
        assert payload.get("ok") is False, (url, payload)


def test_load_refuses_auras_own_token_page(live):
    own = f"http://127.0.0.1:{live['port']}/?token={live['token']}"
    status, payload = call(live["port"], "POST", "/api/player/command",
                           live["token"], {"cmd": "load", "url": own})
    assert status == 400, payload
    assert payload.get("ok") is False


def test_load_still_accepts_a_real_film(live):
    url = "https://example.test/film.mp4"
    status, payload = call(live["port"], "POST", "/api/player/command",
                           live["token"], {"cmd": "load", "url": url})
    assert status == 200, payload
    assert payload["command"]["url"] == url


def test_a_library_entry_may_still_be_removed_by_its_own_url(live):
    # save/remove only book-keep; they must not inherit the play-time scheme rule.
    url = "https://example.test/film.mp4"
    status, payload = call(live["port"], "POST", "/api/player/command",
                           live["token"], {"cmd": "remove", "url": url})
    assert status == 200, payload


# ---------------------------------------------------------------------------
# manage: a page handed to Chrome gets the same check as a film
# ---------------------------------------------------------------------------

def test_manage_window_refuses_auras_own_page(monkeypatch):
    opened = []
    monkeypatch.setattr(server._STATE, "port", 4567)
    monkeypatch.setattr(desktop_window, "open_page",
                        lambda url, title="": (opened.append(url), {"open": True})[1])
    monkeypatch.setattr(desktop_window, "status", lambda: {"open": False})
    for own in ("http://127.0.0.1:4567/?token=abc", "http://localhost:4567/api/state"):
        with pytest.raises(ValueError):
            server.manage_window({"url": own})
    assert opened == []


# ---------------------------------------------------------------------------
# playlist episodes: a video id becomes part of a URL in the page
# ---------------------------------------------------------------------------

def test_playlist_items_drop_a_video_id_that_is_not_a_video_id(dashboard):
    renderers = [{"playlistVideoRenderer": {"videoId": vid, "title": {"simpleText": "t"}}}
                 for vid in ("abcdefghijk", "../../etc/x", "abc/defghij")]
    out: list = []
    dashboard._walkPlaylist({"contents": renderers}, out)
    assert [item["videoId"] for item in out] == ["abcdefghijk"]


# ---------------------------------------------------------------------------
# the listener: loopback only, and every data route behind the token
# ---------------------------------------------------------------------------

def test_the_server_binds_loopback_only(live):
    address = server._STATE.httpd.server_address
    assert address[0] == "127.0.0.1", address


GET_ROUTES = ("/healthz", "/api/state", "/api/presets", "/api/catalog", "/api/config",
              "/api/player", "/api/window", "/api/player/commands?after=0")
POST_ROUTES = ("/api/control", "/api/mood", "/api/config/push", "/api/audio",
               "/api/player/report", "/api/player/command", "/api/window/open",
               "/api/window/close", "/api/window/manage")


def test_every_data_route_requires_the_token(live):
    for path in GET_ROUTES:
        status, _ = call(live["port"], "GET", path)
        assert status == 401, (path, status)
        status, _ = call(live["port"], "GET", path, live["token"])
        assert status != 401 and status < 500, (path, status)
    for path in POST_ROUTES:
        status, _ = call(live["port"], "POST", path, None, {"cmd": "pause"})
        assert status == 401, (path, status)
