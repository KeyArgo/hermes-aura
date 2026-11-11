import threading
import time

from aura_core import server
from aura_core.capture import base as capture


class Live:
    name = "pulse"

    def __init__(self):
        self.closed = False

    def read(self, n=capture.FRAME_SAMPLES):
        time.sleep(0.005)
        return b"\x01\x00\x00\x00" * n

    def close(self):
        self.closed = True


def _run(monkeypatch, wanted):
    opened = []

    def fake_open(preferred=None):
        opened.append(Live())
        return opened[-1]

    monkeypatch.setattr(capture, "open_capture", fake_open)
    monkeypatch.setattr(server, "_audio_wanted", lambda: wanted[0])
    monkeypatch.setattr(server, "CAPTURE_GATE_S", 0.05)
    monkeypatch.setattr(server, "publish_config", lambda: None)
    stop = threading.Event()
    worker = threading.Thread(target=server._capture_loop, args=(stop,), daemon=True)
    worker.start()
    return opened, stop, worker


def _wait_for(name, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with server._STATE.lock:
            if server._STATE.capture_name == name:
                return True
        time.sleep(0.02)
    return False


def _stop(stop, worker):
    stop.set()
    worker.join(2)
    assert not worker.is_alive()


def test_disabled_never_opens_a_recorder(monkeypatch):
    opened, stop, worker = _run(monkeypatch, [False])
    time.sleep(0.3)
    _stop(stop, worker)
    assert opened == []


def test_switching_off_closes_the_recorder_and_on_reopens_it(monkeypatch):
    wanted = [True]
    opened, stop, worker = _run(monkeypatch, wanted)
    assert _wait_for("pulse")
    wanted[0] = False
    assert _wait_for("none")
    assert opened[0].closed  # privacy: nothing keeps listening while off
    wanted[0] = True
    assert _wait_for("pulse")  # reopened at once, not after CAPTURE_RETRY_S
    _stop(stop, worker)
    assert len(opened) == 2


def test_idle_stops_listening_and_the_next_viewer_reopens_it(monkeypatch):
    """No page attached means no audience: after IDLE_STOP_S, stop paying for audio."""
    monkeypatch.setattr(server, "IDLE_STOP_S", 0.05)
    monkeypatch.setattr(server.config, "load_config",
                        lambda: {"enabled": True, "motion": "both", "listen_background": False})
    opened, stop, worker = _run(monkeypatch, [True])
    assert _wait_for("pulse")
    assert _wait_for("none", timeout=2.5), "capture kept running with no listeners"
    assert len(opened) == 1 and opened[0].closed

    # A page appears: reopen without waiting for CAPTURE_RETRY_S.
    class FakeClient:
        # The loop pushes PCM and events to every connected page; a stand-in only
        # needs to absorb whatever it is handed.
        def __getattr__(self, name):
            return lambda *a, **k: None

    sentinel = FakeClient()
    with server._STATE.lock:
        server._STATE.clients.add(sentinel)
    try:
        assert _wait_for("pulse", timeout=2.0), "capture did not resume for a returning viewer"
    finally:
        with server._STATE.lock:
            server._STATE.clients.discard(sentinel)
    _stop(stop, worker)
    assert len(opened) == 2


def test_background_listening_keeps_capture_alive_with_no_listeners(monkeypatch):
    monkeypatch.setattr(server, "IDLE_STOP_S", 0.05)
    monkeypatch.setattr(server.config, "load_config",
                        lambda: {"enabled": True, "motion": "both", "listen_background": True})
    opened, stop, worker = _run(monkeypatch, [True])
    assert _wait_for("pulse")
    time.sleep(0.4)
    with server._STATE.lock:
        assert server._STATE.capture_name == "pulse", "listen_background should not idle out"
    _stop(stop, worker)
    assert len(opened) == 1


def test_audio_wanted_follows_enabled_and_motion(monkeypatch):
    # Only motions that drive the visuals from real audio may open a recorder.
    for cfg, want in [({"enabled": False, "motion": "both"}, False),
                      ({"enabled": False, "motion": "music"}, False),
                      ({"enabled": True, "motion": "designs"}, False),
                      ({"enabled": True, "motion": "agent"}, False),
                      ({"enabled": True, "motion": "both"}, True),
                      ({"enabled": True, "motion": "music"}, True),
                      ({"enabled": True, "motion": "agent_music"}, True)]:
        monkeypatch.setattr(server.config, "load_config", lambda c=cfg: c)
        assert server._audio_wanted() is want
