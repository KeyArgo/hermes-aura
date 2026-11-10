"""The film endpoints: player reports, the command queue, and the pop-out.

The window itself is faked (no browser is launched); what is proved here is the
wire: report merge, seq ordering, query-token auth for the window's own page,
and the agent-facing window endpoints.
"""

from __future__ import annotations

import http.client
import json

import pytest

from aura_core import server


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
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, json.loads(payload.decode("utf-8") or "{}")


# ---------------------------------------------------------------------------
# the player report
# ---------------------------------------------------------------------------

def test_report_is_merged_and_readable(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", "/api/player/report", token, {
        "url": "https://example.test/film.mp4", "playing": True,
        "position": 12.5, "duration": 600, "title": "Octopus", "desktop": True,
    })
    assert status == 200 and body["ok"] is True
    assert isinstance(body["seq"], int) and body["seq"] >= 1

    status, payload = call(port, "GET", "/api/player", token)
    assert status == 200
    player = payload["player"]
    assert player["url"] == "https://example.test/film.mp4"
    assert player["playing"] is True
    assert player["position"] == 12.5
    assert player["title"] == "Octopus"
    assert player["desktop"] is True
    assert player["ts"] > 0

    # A second report omitting title keeps what was known.
    call(port, "POST", "/api/player/report", token, {"playing": False, "position": 20})
    _s, payload = call(port, "GET", "/api/player", token)
    assert payload["player"]["playing"] is False
    assert payload["player"]["position"] == 20.0
    assert payload["player"]["title"] == "Octopus"


def test_report_rejects_non_object(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", "/api/player/report", token, [1, 2])
    assert status == 400
    assert body["ok"] is False


def test_player_page_may_report_with_the_query_token(live):
    port, token = live["port"], live["token"]
    status, body = call(port, "POST", f"/api/player/report?token={token}",
                        None, {"playing": True, "position": 3})
    assert status == 200 and body["ok"] is True


def test_player_page_without_any_token_is_refused(live):
    port = live["port"]
    status, body = call(port, "POST", "/api/player/report", None, {"playing": True})
    assert status == 401 and body["error"] == "unauthorized"


# ---------------------------------------------------------------------------
# the command queue
# ---------------------------------------------------------------------------

def test_commands_are_ordered_and_cursor_is_exclusive(live):
    port, token = live["port"], live["token"]
    seqs = []
    for cmd, extra in (("pause", {}), ("next", {}), ("seek", {"value": 90.0})):
        status, body = call(port, "POST", "/api/player/command", token,
                            {"cmd": cmd, **extra})
        assert status == 200 and body["ok"] is True
        seqs.append(body["seq"])
    assert seqs == sorted(seqs) and len(set(seqs)) == 3

    _s, first = call(port, "GET", "/api/player/commands?after=0", token)
    assert [c["cmd"] for c in first["commands"]] == ["pause", "next", "seek"]
    assert [c["seq"] for c in first["commands"]] == seqs

    _s, later = call(port, "GET", f"/api/player/commands?after={seqs[0]}", token)
    assert [c["cmd"] for c in later["commands"]] == ["next", "seek"]

    _s, none = call(port, "GET", f"/api/player/commands?after={seqs[-1]}", token)
    assert none["commands"] == []
    assert none["seq"] == seqs[-1]


def test_command_queue_polls_with_the_query_token(live):
    port, token = live["port"], live["token"]
    call(port, "POST", "/api/player/command", token, {"cmd": "pause"})
    status, body = call(port, "GET", f"/api/player/commands?after=0&token={token}")
    assert status == 200
    assert [c["cmd"] for c in body["commands"]] == ["pause"]


def test_commands_query_without_token_is_refused(live):
    port = live["port"]
    status, _body = call(port, "GET", "/api/player/commands?after=0")
    assert status == 401


@pytest.mark.parametrize("body", [
    {"cmd": "explode"},
    {"cmd": "seek"},
    {"cmd": "seek", "value": "soon"},
    {"cmd": "volume"},
    {"cmd": "load"},
    {},
])
def test_bad_commands_are_rejected(live, body):
    status, payload = call(live["port"], "POST", "/api/player/command",
                           live["token"], body)
    assert status == 400
    assert payload["ok"] is False


def test_volume_is_clamped(live):
    _s, body = call(live["port"], "POST", "/api/player/command", live["token"],
                    {"cmd": "volume", "value": 4})
    assert body["command"]["value"] == 1.0


def test_queue_is_bounded(live):
    port, token = live["port"], live["token"]
    for _ in range(server.MAX_QUEUED_COMMANDS + 5):
        call(port, "POST", "/api/player/command", token, {"cmd": "toggle"})
    _s, payload = call(port, "GET", "/api/player/commands?after=0", token)
    assert len(payload["commands"]) == server.MAX_QUEUED_COMMANDS
    newest = payload["commands"][-1]["seq"]
    assert newest == server._STATE.command_seq


# ---------------------------------------------------------------------------
# the pop-out window endpoints
# ---------------------------------------------------------------------------

def test_window_status_answers_without_a_browser(live, monkeypatch):
    monkeypatch.setattr(server.desktop_window, "find_browser", lambda: None)
    status, body = call(live["port"], "GET", "/api/window", live["token"])
    assert status == 200
    assert body["ok"] is True
    assert body["open"] is False
    assert body["available"] is False
    assert "token" not in json.dumps(body)


def test_window_open_refuses_with_no_film(live):
    status, body = call(live["port"], "POST", "/api/window/open", live["token"], {})
    assert status == 400
    assert "no film" in body["error"]


def test_window_open_reports_a_missing_browser(live, monkeypatch):
    def no_browser(*args, **kwargs):
        raise server.desktop_window.WindowError("no Chrome or Chromium found")

    monkeypatch.setattr(server.desktop_window, "open_window", no_browser)
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": "https://example.test/film.mp4"})
    assert status == 503
    assert body["ok"] is False
    assert "Chrome" in body["error"]


def test_window_open_passes_token_and_position(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, position=0.0, label=""):
        seen.update(port=port, token=token, url=url, position=position, label=label)
        return {"open": True, "already": False, "url": url, "pid": 1234}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": True, "available": True, "url": "", "pid": 1234,
                                 "browser": "chromium"})
    status, body = call(live["port"], "POST", "/api/window/open", live["token"],
                        {"url": "https://example.test/film.mp4", "position": 42,
                         "label": "Octopus"})
    assert status == 200 and body["ok"] is True
    assert seen["port"] == live["port"]
    assert seen["token"] == live["token"]
    assert seen["url"] == "https://example.test/film.mp4"
    assert seen["position"] == 42.0
    assert seen["label"] == "Octopus"
    assert body["window"]["open"] is True
    assert live["token"] not in json.dumps(body)


def test_window_open_falls_back_to_the_reported_film(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, position=0.0, label=""):
        seen["url"] = url
        return {"open": True, "already": False, "url": url, "pid": 1}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status", lambda: {"open": True, "available": True})
    call(live["port"], "POST", "/api/player/report", live["token"],
         {"url": "https://example.test/reported.mp4"})
    status, _body = call(live["port"], "POST", "/api/window/open", live["token"], {})
    assert status == 200
    assert seen["url"] == "https://example.test/reported.mp4"


def test_window_close_reports_what_happened(live, monkeypatch):
    monkeypatch.setattr(server.desktop_window, "close_window", lambda: True)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": False, "available": True})
    status, body = call(live["port"], "POST", "/api/window/close", live["token"], {})
    assert status == 200
    assert body == {"ok": True, "closed": True,
                    "window": {"open": False, "available": True}}


def test_window_open_needs_the_bearer_token(live):
    status, body = call(live["port"], "POST", "/api/window/open", None,
                        {"url": "https://example.test/film.mp4"})
    assert status == 401
