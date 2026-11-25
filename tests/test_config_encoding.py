"""Config encoding (review finding: a UTF-16 config.json took serving and capture down).

``load_config`` decodes the file as UTF-8 but caught only ``OSError``, and a
``UnicodeDecodeError`` is a ``ValueError``, not an ``OSError``. So a config
saved by an editor as UTF-16 (or UTF-8 with a BOM) raised out of the reader that
the rest of the app treats as infallible:

* the capture loop's first ``_audio_wanted()`` fell into its open-failure branch
  and used silence, then the second one (the line that seeds ``wanted``, outside
  that branch) ended the thread — no audio for the life of the process;
* ``/api/config`` answered 500, and every control update failed, because it
  reads the same file before saving.

Run: pytest tests/test_config_encoding.py
"""

from __future__ import annotations

import http.client
import json
import time

import pytest

from aura_core import config, server


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def http_call(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(data))
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, payload


@pytest.fixture()
def utf16_live(tmp_path, monkeypatch):
    """A live server whose config.json was already saved as UTF-16 with a BOM."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")  # deterministic: no real audio
    path = tmp_path / "aura" / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps({"enabled": True, "opacity": 0.3}).encode("utf-16"))
    assert path.read_bytes()[:2] == b"\xff\xfe", "the fixture must write a UTF-16 BOM"
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token, "home": tmp_path, "path": path}
    finally:
        server.stop_server()


# ---------------------------------------------------------------------------
# the finding
# ---------------------------------------------------------------------------

def test_utf16_config_still_serves_and_keeps_capture_running(utf16_live):
    port = utf16_live["port"]
    token = utf16_live["token"]

    # Serving: the reader is documented as infallible, so a config it cannot
    # decode is defaults, not a 500.
    status, payload = http_call(port, "GET", "/api/config", token)
    assert status == 200, payload
    served = json.loads(payload.decode("utf-8"))
    assert served["opacity"] == config.DEFAULTS["opacity"]

    # The capture thread must outlive its second config read; without that it is
    # dead before the loop starts and every page gets silence.
    time.sleep(0.3)
    with server._STATE.lock:
        capture_thread = server._STATE.capture_thread
    assert capture_thread is not None
    assert capture_thread.is_alive(), "the capture thread died on the config read"

    # Recovery through Settings: a control update reads the same file, then saves.
    status, payload = http_call(port, "POST", "/api/control", token, {"opacity": 0.5})
    assert status == 200, payload
    assert json.loads(payload.decode("utf-8"))["ok"] is True

    # And it lands on disk, as UTF-8 the next start can read.
    stored = json.loads(utf16_live["path"].read_text(encoding="utf-8"))
    assert stored["opacity"] == 0.5
