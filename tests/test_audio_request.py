"""The audio_request half of the wire: POST /api/audio and GET /api/state.

A real live server is started on a throwaway HERMES_HOME (like
tests/test_server.py), because the point is that the desktop half really can
read the request back from /api/state — not that a mock returns a dict.

Run: .venv/bin/python -m pytest tests/test_audio_request.py -q
"""

from __future__ import annotations

import http.client
import json

import pytest

from aura_core import server


def http_call(port, method, path, token=None, body=None):
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
    payload = response.read()
    conn.close()
    try:
        decoded = json.loads(payload.decode("utf-8") or "{}")
    except ValueError:
        decoded = payload
    return response.status, decoded


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    # Each test starts from "no audio request yet". The seq itself is
    # deliberately monotonic across restarts (see publish_audio_request), so
    # the counter is carried over rather than reset.
    with server._STATE.lock:
        server._STATE.audio_request = None
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        with server._STATE.lock:
            server._STATE.audio_request = None
        server.stop_server()


# ---------------------------------------------------------------------------
# /api/state carries the request
# ---------------------------------------------------------------------------

def test_state_has_no_audio_request_by_default(live):
    status, state = http_call(live["port"], "GET", "/api/state", live["token"])
    assert status == 200
    assert "audio_request" in state, "the desktop polls this key; it must always be there"
    assert state["audio_request"] is None


def test_posting_an_audio_request_shows_up_in_state(live):
    status, payload = http_call(
        live["port"], "POST", "/api/audio", live["token"],
        {"action": "play", "url": "https://ice.example/jazz.mp3", "label": "Jazz FM"})
    assert status == 200 and payload["ok"] is True
    stored = payload["audio_request"]
    assert stored["action"] == "play"
    assert stored["url"] == "https://ice.example/jazz.mp3"
    assert stored["label"] == "Jazz FM"
    assert isinstance(stored["seq"], int) and stored["seq"] > 0
    assert isinstance(stored["at"], int) and stored["at"] > 0

    status, state = http_call(live["port"], "GET", "/api/state", live["token"])
    assert state["audio_request"]["seq"] == stored["seq"]
    assert state["audio_request"]["url"] == "https://ice.example/jazz.mp3"


def test_each_request_gets_a_higher_seq(live):
    seqs = []
    for index in (1, 2, 3):
        status, payload = http_call(
            live["port"], "POST", "/api/audio", live["token"],
            {"action": "play", "url": f"https://ice.example/{index}.mp3", "label": "x"})
        assert status == 200
        seqs.append(payload["audio_request"]["seq"])
    assert seqs == sorted(set(seqs)), "seq must be strictly increasing"
    status, state = http_call(live["port"], "GET", "/api/state", live["token"])
    assert state["audio_request"]["seq"] == seqs[-1]
    assert state["audio_request"]["url"] == "https://ice.example/3.mp3"


def test_stop_and_mute_travel_in_the_same_frame(live):
    for action in ("stop", "mute_video", "unmute_video"):
        status, payload = http_call(live["port"], "POST", "/api/audio", live["token"],
                                    {"action": action})
        assert status == 200, action
        assert payload["audio_request"]["action"] == action
        assert payload["audio_request"]["url"] == ""
    status, payload = http_call(live["port"], "POST", "/api/audio", live["token"],
                                {"action": "volume", "value": 0.25})
    assert payload["audio_request"]["value"] == 0.25


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body,error", [
    ({"action": "play"}, "url_required_for_play"),
    ({"action": "dance"}, "bad_audio_action"),
    ({"action": "volume"}, "volume_must_be_number"),
    ({"action": "volume", "value": 2}, "volume_out_of_range"),
    ({"action": "volume", "value": True}, "volume_must_be_number"),
    ({"action": "play", "url": 5}, "url_must_be_string"),
    ({"action": "play", "url": "https://x/y", "label": 5}, "label_must_be_string"),
])
def test_bad_audio_requests_are_rejected(live, body, error):
    _status, before = http_call(live["port"], "GET", "/api/state", live["token"])
    status, payload = http_call(live["port"], "POST", "/api/audio", live["token"], body)
    assert status == 400, body
    assert payload["error"] == error
    # A rejected request must not change what the desktop sees.
    _status, state = http_call(live["port"], "GET", "/api/state", live["token"])
    assert state["audio_request"] == before["audio_request"]


def test_audio_route_requires_the_token(live):
    status, _ = http_call(live["port"], "POST", "/api/audio", None,
                          {"action": "play", "url": "https://x/y"})
    assert status == 401


# ---------------------------------------------------------------------------
# the page the audio channel lives in is served without a token
# ---------------------------------------------------------------------------

def test_audio_js_is_served_unauthenticated(live):
    status, body = http_call(live["port"], "GET", "/audio.js", None)
    assert status == 200
    assert isinstance(body, bytes)
    assert b"aura: 'audio'" in body
    assert b"__auraAudio" in body
