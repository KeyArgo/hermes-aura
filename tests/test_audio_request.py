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
        server._STATE.audio_requests = []
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        with server._STATE.lock:
            server._STATE.audio_request = None
            server._STATE.audio_requests = []
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
    # [finding 3] Every request survives in order; consuming only the newest
    # used to drop the play when a mute_video followed it in the same turn.
    assert [request["seq"] for request in state["audio_requests"]] == seqs
    assert [request["action"] for request in state["audio_requests"]] == ["play"] * 3


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
    # [finding 9] The page must point <audio> at the server proxy, not at the
    # station hostname: only the server validates and pins redirect hops.
    assert b"/api/radio/stream" in body


class _FakeStream:
    def __init__(self, payload=b"ID3-fake-stream", headers=None, content_type=None):
        self.payload = payload
        if headers is None:
            headers = {"Content-Type": "audio/mpeg" if content_type is None else content_type}
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, size=-1):
        chunk, self.payload = self.payload[:size], self.payload[size:]
        return chunk


def http_get_headers(port, path):
    """GET and keep the response headers (the proxy fix lives in them)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path)
    response = conn.getresponse()
    payload = response.read()
    headers = {name.lower(): value for name, value in response.getheaders()}
    status = response.status
    conn.close()
    return status, headers, payload


def stream_path(live, url="https://ice.example/live.mp3"):
    from urllib.parse import quote

    return f"/api/radio/stream?url={quote(url, safe='')}&token={live['token']}"


def test_radio_stream_is_proxied_through_the_validated_opener(live, monkeypatch):
    calls = []

    def fake_open(url, timeout=15.0):
        calls.append(url)
        return _FakeStream()

    monkeypatch.setattr(server.radio, "open_stream", fake_open)
    path = ("/api/radio/stream?url=https%3A%2F%2Fice.example%2Flive.mp3"
            f"&token={live['token']}")
    status, body = http_call(live["port"], "GET", path)
    assert status == 200
    assert body == b"ID3-fake-stream"
    assert calls == ["https://ice.example/live.mp3"]
    # The proxy is token-gated like every other data endpoint.
    status, _ = http_call(live["port"], "GET",
                          "/api/radio/stream?url=https%3A%2F%2Fice.example%2Flive.mp3")
    assert status == 401


def test_radio_stream_refuses_a_private_url(live, monkeypatch):
    from aura_core.radio import RadioError

    def refuse(url, timeout=15.0):
        raise RadioError("stream url must be public http(s)")

    monkeypatch.setattr(server.radio, "open_stream", refuse)
    path = f"/api/radio/stream?url=http%3A%2F%2F127.0.0.1%2Fstream&token={live['token']}"
    status, payload = http_call(live["port"], "GET", path)
    assert status == 400
    assert payload["error"] == "stream url must be public http(s)"


# ---------------------------------------------------------------------------
# [security] the proxy never turns a station's Content-Type into executable
# content on Aura's origin (finding: Content-Type reflection)
# ---------------------------------------------------------------------------

HOSTILE_PAYLOAD = (
    b"<!doctype html><html><body><script>"
    b"fetch('/api/state?token=' + location.search.slice(1))"
    b"</script></body></html>"
)

# Anything that a browser would run, or that is simply not audio, must not be
# echoed: text/html and both javascript types execute, SVG executes script,
# an XML document can too. text/plain and JSON are harmless but are still not
# audio, so the documented rule (only a safe audio type survives) applies.
HOSTILE_TYPES = [
    "text/html",
    "text/html; charset=utf-8",
    "TEXT/HTML",
    "application/xhtml+xml",
    "application/javascript",
    "text/javascript",
    "image/svg+xml",
    "text/plain",
    "application/json",
    "multipart/x-mixed-replace; boundary=x",
    "audio/x-mpegurl",  # a playlist, not audio
    "not a mime type at all",
]


@pytest.mark.parametrize("hostile", HOSTILE_TYPES)
def test_radio_stream_never_serves_html_or_script(live, monkeypatch, hostile):
    monkeypatch.setattr(
        server.radio, "open_stream",
        lambda url, timeout=15.0: _FakeStream(HOSTILE_PAYLOAD, content_type=hostile))
    status, headers, body = http_get_headers(live["port"], stream_path(live))
    assert status == 200
    # The bytes are relayed unchanged (the proxy is transparent)...
    assert body == HOSTILE_PAYLOAD
    # ...but they can never arrive as a document the browser will execute.
    assert headers["content-type"] == "application/octet-stream", hostile
    assert headers["content-type"] != hostile
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["content-security-policy"] == server.STREAM_CSP
    assert "sandbox" in headers["content-security-policy"]
    assert "allow-scripts" not in headers["content-security-policy"]
    assert "'none'" in headers["content-security-policy"]


def test_radio_stream_without_a_content_type_is_not_a_document(live, monkeypatch):
    monkeypatch.setattr(
        server.radio, "open_stream",
        lambda url, timeout=15.0: _FakeStream(HOSTILE_PAYLOAD, headers={}))
    status, headers, body = http_get_headers(live["port"], stream_path(live))
    assert status == 200
    assert body == HOSTILE_PAYLOAD
    # ICY servers often omit the header entirely; the historical audio default
    # stays (it is not executable) and the sandbox CSP is still attached.
    assert headers["content-type"] == "audio/mpeg"
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["content-security-policy"] == server.STREAM_CSP


@pytest.mark.parametrize("upstream,expected", [
    ("audio/mpeg", "audio/mpeg"),
    ("AUDIO/MPEG", "audio/mpeg"),
    ("audio/mp3", "audio/mpeg"),
    ("audio/aac", "audio/aac"),
    ("audio/aacp", "audio/aacp"),
    ("audio/ogg; codecs=opus", "audio/ogg"),
    ("application/ogg", "audio/ogg"),
    ("audio/webm", "audio/webm"),
    ("audio/wav", "audio/wav"),
    ("audio/x-wav", "audio/wav"),
    ("audio/flac", "audio/flac"),
    ("audio/x-m4a", "audio/mp4"),
    ("application/octet-stream", "application/octet-stream"),
])
def test_radio_stream_keeps_safe_audio_types(live, monkeypatch, upstream, expected):
    payload = b"ID3\x04\x00\x00\x00\x00\x00\x00"
    monkeypatch.setattr(
        server.radio, "open_stream",
        lambda url, timeout=15.0: _FakeStream(payload, content_type=upstream))
    status, headers, body = http_get_headers(live["port"], stream_path(live))
    assert status == 200
    assert body == payload
    assert headers["content-type"] == expected, upstream
    # Parameters are dropped: a station has no say in Aura's charset.
    assert ";" not in headers["content-type"]
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["content-security-policy"] == server.STREAM_CSP


def test_proxy_content_type_whitelist_unit():
    """The header mapping itself: exact audio survives, everything else opaque."""
    assert server._proxy_content_type("audio/mpeg") == "audio/mpeg"
    assert server._proxy_content_type("  Audio/MPEG ; charset=utf-8") == "audio/mpeg"
    assert server._proxy_content_type("audio/ogg; codecs=opus") == "audio/ogg"
    assert server._proxy_content_type("text/html") == "application/octet-stream"
    assert server._proxy_content_type("image/svg+xml") == "application/octet-stream"
    assert server._proxy_content_type("text/html; charset=utf-8") == "application/octet-stream"
    assert server._proxy_content_type("") == "audio/mpeg"       # header present, empty
    assert server._proxy_content_type(None) == "audio/mpeg"     # header absent
    assert server._proxy_content_type(b"audio/mpeg") == "application/octet-stream"
    assert server._proxy_content_type(5) == "application/octet-stream"
