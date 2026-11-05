"""Server contract tests: auth, host guard, control validation, WS, lifecycle.

Run with the shared venv:
    /mnt/homes/Development/hermes-aura/.venv/bin/python -m pytest tests -q
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import struct
import time

import pytest

from aura_core import config, redact
from aura_core import server


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

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


def http_call(port, method, path, token=None, body=None, host=None, headers=None):
    """Raw request helper so the Host header can be controlled."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    hdrs = dict(headers or {})
    if token is not None:
        hdrs["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
        hdrs["Content-Length"] = str(len(data))
    if host is not None:
        conn.putrequest(method, path, skip_host=True)
        conn.putheader("Host", host)
        for key, value in hdrs.items():
            conn.putheader(key, value)
        conn.endheaders(data)
    else:
        conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, payload


def json_body(payload: bytes):
    return json.loads(payload.decode("utf-8"))


# ---------------------------------------------------------------------------
# minimal stdlib WebSocket client (server frames are unmasked)
# ---------------------------------------------------------------------------

class WSClient:
    def __init__(self, port: int, token: str, timeout: float = 5.0):
        self._buffer = b""
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET /api/stream?token={token} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        self.response = self._read_until(b"\r\n\r\n")
        self.status = self.response.split(b"\r\n", 1)[0]

    def _read_until(self, marker: bytes) -> bytes:
        data = b""
        while marker not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data += chunk
        index = data.find(marker)
        if index == -1:
            self._buffer = b""
            return data
        end = index + len(marker)
        self._buffer = data[end:]
        return data[:end]

    def _recv_exact(self, n: int) -> bytes:
        while len(self._buffer) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("socket closed")
            self._buffer += chunk
        data = self._buffer[:n]
        self._buffer = self._buffer[n:]
        return data

    def recv(self):
        b0, b1 = self._recv_exact(2)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
        return opcode, payload

    def send_text(self, obj) -> None:
        payload = json.dumps(obj).encode("utf-8")
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        else:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
        self.sock.sendall(bytes(header) + masked)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# HTTP auth / host guard
# ---------------------------------------------------------------------------

def test_missing_token_is_401(live):
    status, _ = http_call(live["port"], "GET", "/healthz")
    assert status == 401


def test_bad_token_is_401(live):
    status, _ = http_call(live["port"], "GET", "/healthz", token="not-the-token")
    assert status == 401


def test_good_token_healthz(live):
    status, payload = http_call(live["port"], "GET", "/healthz", token=live["token"])
    assert status == 200
    body = json_body(payload)
    assert body["ok"] is True
    assert body["version"] == "0.1.0"
    assert body["capture"] == "none"
    assert body["rate"] == 48000
    assert isinstance(body["clients"], int)
    assert isinstance(body["pid"], int)


def test_host_header_guard(live):
    status, payload = http_call(live["port"], "GET", "/healthz",
                                token=live["token"], host="evil.example:1234")
    assert status == 403
    assert json_body(payload)["error"] == "bad_host"
    status, _ = http_call(live["port"], "GET", "/healthz",
                          token=live["token"], host=f"localhost:{live['port']}")
    assert status == 200


def test_unknown_path_is_404(live):
    status, _ = http_call(live["port"], "GET", "/nope", token=live["token"])
    assert status == 404


def test_token_file_mode_and_rotation(live, tmp_path):
    path = tmp_path / "aura" / "token"
    assert path.exists()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    first = path.read_text(encoding="utf-8").strip()
    assert first == live["token"]
    assert len(first) >= 32

    server.stop_server()
    server.ensure_server()
    second = server.get_token()
    assert second and second != first
    assert path.read_text(encoding="utf-8").strip() == second


# ---------------------------------------------------------------------------
# control
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body", [
    {"intensity": 1.5},
    {"intensity": -0.1},
    {"intensity": "loud"},
    {"enabled": "yes"},
    {"preset": 42},
    {"mood": "bogus"},
    {"mood": 3},
    [],
])
def test_control_rejects_bad_bodies(live, body):
    status, payload = http_call(live["port"], "POST", "/api/control",
                                token=live["token"], body=body)
    assert status == 400
    assert json_body(payload)["ok"] is False


def test_control_rejects_non_json(live):
    conn = http.client.HTTPConnection("127.0.0.1", live["port"], timeout=5)
    conn.request("POST", "/api/control", body=b"{not json",
                 headers={"Authorization": f"Bearer {live['token']}",
                          "Content-Type": "application/json"})
    resp = conn.getresponse()
    assert resp.status == 400
    conn.close()


def test_control_applies_and_persists(live, tmp_path):
    status, payload = http_call(live["port"], "POST", "/api/control",
                                token=live["token"],
                                body={"enabled": True, "intensity": 0.7,
                                      "preset": "aura-bloom"})
    assert status == 200
    applied = json_body(payload)
    assert applied == {"ok": True, "applied": {"enabled": True,
                                               "intensity": 0.7,
                                               "preset": "aura-bloom"}}

    cfg_path = tmp_path / "aura" / "config.json"
    stored = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert stored["enabled"] is True
    assert stored["intensity"] == 0.7
    assert stored["preset"] == "aura-bloom"
    assert oct(cfg_path.stat().st_mode & 0o777) == "0o600"

    status, payload = http_call(live["port"], "GET", "/api/state", token=live["token"])
    state = json_body(payload)
    assert state["enabled"] is True
    assert state["intensity"] == 0.7
    assert state["preset"] == "aura-bloom"
    assert len(state["bands"]) == 8
    assert state["silence"] is True
    assert state["level"] == 0.0

    status, payload = http_call(live["port"], "GET", "/api/config", token=live["token"])
    cfg = json_body(payload)
    assert cfg["intensity"] == 0.7
    assert cfg["capture"] == "none"
    assert cfg["reduced_motion"] is False
    assert "theme_opt_in" in cfg


def test_presets_shape(live):
    status, payload = http_call(live["port"], "GET", "/api/presets", token=live["token"])
    assert status == 200
    body = json_body(payload)
    assert isinstance(body["presets"], list) and body["presets"]
    for preset in body["presets"]:
        assert isinstance(preset["name"], str)
        assert isinstance(preset["family"], str)
        assert isinstance(preset["strobe"], bool)
    assert isinstance(body["default"], str)


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

def test_ws_handshake_and_binary_pcm_frame(live):
    ws = WSClient(live["port"], live["token"])
    try:
        assert ws.status.startswith(b"HTTP/1.1 101"), ws.status
        assert b"sec-websocket-accept" in ws.response.lower()
        deadline = time.time() + 5
        got_binary = None
        while time.time() < deadline:
            opcode, payload = ws.recv()
            if opcode == 0x2:
                got_binary = payload
                break
        assert got_binary is not None, "no binary PCM frame arrived"
        magic, version, flags, hlen, seq, ts_ms, rate, n = struct.unpack(
            "<4sBBHQQII", got_binary[:32])
        assert magic == b"AURA"
        assert version == 1
        assert hlen == 32
        assert rate == 48000
        assert 1 <= n <= 1024
        assert len(got_binary) == 32 + 4 * n
        assert seq >= 1
        assert ts_ms > 0
    finally:
        ws.close()


def test_ws_features_text_frame(live):
    ws = WSClient(live["port"], live["token"])
    try:
        deadline = time.time() + 5
        feature = None
        while time.time() < deadline:
            opcode, payload = ws.recv()
            if opcode != 0x1:
                continue
            event = json.loads(payload.decode("utf-8"))
            if event.get("type") == "features":
                feature = event
                break
        assert feature is not None
        assert set(feature) >= {"type", "seq", "ts_ms", "level", "bands",
                                "onset", "centroid", "flatness", "silence"}
        assert len(feature["bands"]) == 8
        assert 0.0 <= feature["level"] <= 1.0
        assert feature["silence"] is True  # capture is forced to "none"
    finally:
        ws.close()


def test_features_rate_is_capped(live):
    ws = WSClient(live["port"], live["token"])
    try:
        start = time.time()
        count = 0
        while time.time() - start < 1.2:
            try:
                opcode, payload = ws.recv()
            except (socket.timeout, EOFError):
                break
            if opcode == 0x1 and json.loads(payload.decode())["type"] == "features":
                count += 1
        assert 5 <= count <= 13, f"features at {count}/1.2s"
    finally:
        ws.close()


def test_publish_mood_reaches_connected_client(live):
    ws = WSClient(live["port"], live["token"])
    try:
        time.sleep(0.2)
        server.publish_mood("thinking", 0.8, 2000)
        deadline = time.time() + 5
        mood = None
        while time.time() < deadline:
            opcode, payload = ws.recv()
            if opcode != 0x1:
                continue
            event = json.loads(payload.decode("utf-8"))
            if event.get("type") == "mood":
                mood = event
                break
        assert mood is not None, "mood event was not delivered"
        assert mood["mood"] == "thinking"
        assert 0.0 <= mood["intensity"] <= 1.0
        assert mood["ttl_ms"] == 2000
        assert isinstance(mood["seq"], int)
    finally:
        ws.close()


def test_publish_mood_without_clients_is_safe(live):
    server.publish_mood("error", 1.0, 1500)
    server.publish_mood("not-a-mood", 0.5, 0)
    server.publish_mood(None, "bad", "bad")
    server.publish_config()


def test_ws_ping_gets_pong(live):
    ws = WSClient(live["port"], live["token"])
    try:
        ws.send_text({"type": "ping"})
        deadline = time.time() + 5
        pong = False
        while time.time() < deadline:
            opcode, payload = ws.recv()
            if opcode == 0x1 and json.loads(payload.decode())["type"] == "pong":
                pong = True
                break
        assert pong
    finally:
        ws.close()


def test_ws_bad_token_closes_1008(live):
    ws = WSClient(live["port"], "wrong-token")
    try:
        assert ws.status.startswith(b"HTTP/1.1 101")
        opcode, payload = ws.recv()
        assert opcode == 0x8
        code = struct.unpack(">H", payload[:2])[0]
        assert code == 1008
    finally:
        ws.close()


# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------

def test_stop_server_leaves_no_listener(live):
    port = live["port"]
    server.stop_server()
    assert server.get_port() is None
    deadline = time.time() + 3
    while True:
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=0.5)
            sock.close()
        except OSError:
            break
        assert time.time() < deadline, "listener still accepting after stop_server"
        time.sleep(0.05)


def test_ensure_server_is_idempotent(live):
    port = live["port"]
    server.ensure_server()
    server.ensure_server()
    assert server.get_port() == port


# ---------------------------------------------------------------------------
# redaction (used on every URL that reaches the model)
# ---------------------------------------------------------------------------

def test_config_tolerates_corrupt_json(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = tmp_path / "aura" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{this is not json", encoding="utf-8")
    cfg = config.load_config()
    assert cfg == config.DEFAULTS
    saved = config.save_config({"enabled": True, "intensity": 2.5, "preset": 7})
    assert saved["enabled"] is True
    assert saved["intensity"] == 1.0
    assert saved["preset"] is None
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert json.loads(path.read_text(encoding="utf-8"))["enabled"] is True


def _next_mood(ws, timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        opcode, payload = ws.recv()
        if opcode != 0x1:
            continue
        event = json.loads(payload.decode("utf-8"))
        if event.get("type") == "mood":
            return event["mood"]
    return None


def test_mood_ttl_restores_previous_mood(live):
    ws = WSClient(live["port"], live["token"])
    try:
        time.sleep(0.2)
        server.publish_mood("thinking", 0.8, 0)
        assert _next_mood(ws) == "thinking"
        server.publish_mood("error", 1.0, 150)
        assert _next_mood(ws) == "error"
        # ttl expires back to the previous mood (restore-on-clear), never latched.
        assert _next_mood(ws) == "thinking"
    finally:
        ws.close()


def test_mood_cleared_when_page_disconnects(live):
    ws = WSClient(live["port"], live["token"])
    try:
        time.sleep(0.2)
        server.publish_mood("thinking", 0.9, 0)
        assert _next_mood(ws) == "thinking"
        status, payload = http_call(live["port"], "GET", "/api/state", token=live["token"])
        assert json_body(payload)["mood"] == "thinking"
        ws.close()
        deadline = time.time() + 3
        mood = None
        while time.time() < deadline:
            status, payload = http_call(live["port"], "GET", "/api/state",
                                        token=live["token"])
            mood = json_body(payload)["mood"]
            if mood == "idle":
                break
            time.sleep(0.05)
        assert mood == "idle"
    finally:
        ws.close()


def test_disable_clears_mood(live):
    status, _ = http_call(live["port"], "POST", "/api/control", token=live["token"],
                          body={"mood": "error"})
    assert status == 200
    status, payload = http_call(live["port"], "GET", "/api/state", token=live["token"])
    assert json_body(payload)["mood"] == "error"
    status, _ = http_call(live["port"], "POST", "/api/control", token=live["token"],
                          body={"enabled": False})
    assert status == 200
    status, payload = http_call(live["port"], "GET", "/api/state", token=live["token"])
    assert json_body(payload)["mood"] == "idle"


def test_redact_url_masks_token_keeps_host():
    token = "abcdefghijklmnopqrstuvwxyz012345"
    url = f"http://127.0.0.1:4321/?token={token}"
    masked = redact.redact_url(url)
    assert token not in masked
    assert "127.0.0.1:4321" in masked
    assert "abcd" in masked and "2345" in masked
    assert masked.endswith("2345")


def test_redact_text_masks_any_token_occurrence():
    token = "s3cr3t-token-value-1234"
    out = redact.redact_text(f"GET /api/stream?token={token} HTTP/1.1", token)
    assert token not in out
    assert "s3cr" in out


# ---------------------------------------------------------------------------
# static assets + preset catalogue (page/server integration)
# ---------------------------------------------------------------------------

def test_static_assets_public_data_endpoints_gated(live):
    for path in ("/aura.js", "/pcm-worklet.js", "/presets.json", "/vendor/butterchurn.min.js"):
        status, payload = http_call(live["port"], "GET", path)
        assert status == 200, path
        assert payload, path
    status, _ = http_call(live["port"], "GET", "/api/state")
    assert status == 401
    status, _ = http_call(live["port"], "GET", "/api/state", token=live["token"])
    assert status == 200


def test_static_serving_stays_inside_web_dir(live):
    bad = ("/vendor/../../etc/passwd", "/vendor/sub/dir.js", "/not-a-file.js")
    # Without the token an unknown path is refused at the gate (401) — either way
    # it must never be served from outside web/.
    for path in bad:
        status, _ = http_call(live["port"], "GET", path)
        assert status in (401, 404), (path, status)
    for path in bad:
        status, payload = http_call(live["port"], "GET", path, token=live["token"])
        assert status == 404, (path, status)
        assert b"passwd" not in payload


def test_presets_come_from_the_page_catalogue(live):
    status, payload = http_call(live["port"], "GET", "/api/presets", token=live["token"])
    assert status == 200
    data = json_body(payload)
    names = {p["name"] for p in data["presets"]}
    # web/presets.json is the same file the page resolves against, so every name
    # here must be loadable in butterchurn. The old built-in list was not.
    assert names, data
    assert data["default"] in names
    assert "aura-drift" not in names, "built-in fallback leaked instead of web/presets.json"


def test_config_event_carries_enabled():
    event = server._config_event()
    assert event["type"] == "config"
    assert isinstance(event["enabled"], bool)
