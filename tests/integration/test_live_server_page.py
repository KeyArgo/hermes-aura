"""Integration: the REAL server serving the REAL page into muted headless Chrome.

This is the test the lane suites could not write: it proves the pieces fit.

  1. static assets are served without a token (a browser cannot send one for
     <script src>) while every data endpoint stays token-gated,
  2. the page boots with no JS errors and connects its WebSocket,
  3. PCM frames reach the AudioWorklet and the canvas renders frames,
  4. nothing is audible (muted gain 0),
  5. a mood published by the Python side (what the agent hooks call) arrives in
     the page and changes its state.

Skipped when there is no Chrome or no system-audio backend: the page blocks
itself on capture=none, so frame assertions would be meaningless there.

Run: python -m pytest tests/integration -q
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import pytest

CHROME = next(
    (p for p in ("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
                 "/usr/bin/chromium", shutil.which("chromium") or "") if p and os.path.exists(p)),
    None,
)


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    from aura_core import server as S

    # Isolated home: this test writes config (enabled=true) and must not touch
    # the user's real ~/.hermes/aura/config.json.
    home = tmp_path_factory.mktemp("aura-home")
    saved = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(home)
    S.stop_server()
    S.ensure_server()
    for _ in range(40):
        if S.get_port():
            break
        time.sleep(0.25)
    port, token = S.get_port(), S.get_token()
    if not port:
        pytest.skip("Aura server did not start")
    # The capture thread probes backends asynchronously; give it time to settle
    # before deciding there is no audio on this machine.
    capture = "none"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            capture = S.get_capture()
        except Exception:  # noqa: BLE001
            capture = "none"
        if capture != "none":
            break
        time.sleep(0.25)
    yield {"port": port, "token": token, "capture": capture, "server": S}
    S.stop_server()
    if saved is None:
        os.environ.pop("HERMES_HOME", None)
    else:
        os.environ["HERMES_HOME"] = saved


def _cdp_session(url: str):
    """Open `url` in muted headless Chrome and return (evaluate, snapshot, cleanup)."""
    prof = tempfile.mkdtemp()
    assert CHROME is not None
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
         f"--user-data-dir={prof}", "--remote-debugging-port=0", "--remote-allow-origins=*",
         "--window-size=1280,860", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import websocket  # provided by the shared venv

    def cleanup():
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(prof, ignore_errors=True)

    for _ in range(80):
        if os.path.exists(os.path.join(prof, "DevToolsActivePort")):
            break
        time.sleep(0.2)
    dport = open(os.path.join(prof, "DevToolsActivePort")).read().split()[0]
    tab = json.load(urllib.request.urlopen(urllib.request.Request(
        f"http://127.0.0.1:{dport}/json/new?about:blank", method="PUT")))
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"])
    seq = [0]

    def call(method, params=None):
        seq[0] += 1
        ws.send(json.dumps({"id": seq[0], "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == seq[0]:
                return msg

    # /json/new?<url> mangles a nested ?token= query — navigate over CDP instead.
    call("Page.navigate", {"url": url})
    time.sleep(0.5)

    def ev(expr):
        res = (call("Runtime.evaluate", {"expression": expr, "awaitPromise": True,
                                         "returnByValue": True}) or {}).get("result", {})
        if res.get("exceptionDetails"):
            return None
        return res.get("result", {}).get("value")

    def snapshot():
        return ev("window.__aura && window.__aura.snapshot()")

    return ev, snapshot, cleanup


@pytest.mark.skipif(CHROME is None, reason="no Chrome-family browser installed")
def test_real_server_real_page(live_server):
    server = live_server["server"]
    port, token = live_server["port"], live_server["token"]
    if live_server["capture"] == "none":
        pytest.skip("no system-audio backend here; the page blocks itself on capture=none")

    # 1. static assets are public, data endpoints are not
    for path in ("/aura.js", "/pcm-worklet.js", "/presets.json", "/vendor/butterchurn.min.js"):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as resp:
            assert resp.status == 200, path
            assert resp.read(), path
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=5)
    assert exc.value.code == 401

    url = f"http://127.0.0.1:{port}/?token={token}"
    ev, snapshot, cleanup = _cdp_session(url)
    try:
        boot = None
        for _ in range(80):
            boot = snapshot()
            if boot and boot.get("ready") and boot.get("socketState") == "connected":
                break
            time.sleep(0.25)
        assert boot and boot.get("ready"), "page never became ready"
        assert not boot.get("errors"), boot.get("errors")
        assert boot.get("socketState") == "connected"
        assert boot.get("capture") == live_server["capture"]

        # privacy default is OFF; desktop settings or the tool can turn it on via /api/control
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/control",
            data=json.dumps({"enabled": True, "intensity": 0.6}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                     "Host": f"127.0.0.1:{port}"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert json.loads(resp.read())["applied"]["enabled"] is True

        deadline = time.time() + 12
        snap = None
        while time.time() < deadline:
            snap = snapshot()
            if snap and snap.get("enabled") and (snap.get("frames") or 0) > 0:
                break
            time.sleep(0.4)
        assert snap and snap.get("enabled"), "page did not follow the control change"
        assert (snap.get("frames") or 0) > 0, "no frames rendered"
        assert (snap.get("badFrames") or 0) == 0
        assert snap.get("audio", {}).get("worklet") is True
        assert snap.get("audio", {}).get("mutedGain") == 0, "Aura must not make sound"

        # 5. a mood from the Python side (what the agent hooks call) reaches the page
        server.publish_mood("approval", 0.8, 5000)
        time.sleep(0.8)
        mood = snapshot() or {}
        assert mood.get("mood") == "approval", mood.get("mood")
        assert mood.get("intensity", 0) >= 0.6
        print("\nVERDICT:", json.dumps({
            "capture": live_server["capture"],
            "frames": snap.get("frames"),
            "canvas": snap.get("canvasAttrs"),
            "quality": snap.get("quality", {}).get("tier"),
            "preset": snap.get("preset"),
            "mood_delivered": mood.get("mood"),
        }))
    finally:
        cleanup()
