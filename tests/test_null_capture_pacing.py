import threading
import time

from aura_core import server
from aura_core.capture import base as capture


def test_silence_fallback_is_paced_to_real_time(monkeypatch):
    # Regression: with no audio backend, NullCapture returned frames instantly
    # and _capture_loop spun a full core inside the Hermes gateway.
    monkeypatch.setattr(capture, "open_capture", lambda preferred=None: capture.NullCapture())
    stop = threading.Event()
    with server._STATE.lock:
        start_seq = server._STATE.pcm_seq
    worker = threading.Thread(target=server._capture_loop, args=(stop,), daemon=True)
    worker.start()
    time.sleep(0.5)
    stop.set()
    worker.join(2)
    assert not worker.is_alive()
    with server._STATE.lock:
        frames = server._STATE.pcm_seq - start_seq
    # Real time is ~23 frames per 0.5 s (1024 samples @ 48 kHz).
    assert frames < 60, frames


def test_silence_fallback_retries_real_backend(monkeypatch):
    # The first probe can miss audio; the loop must pick up a backend later.
    class Live:
        name = "pulse"

        def read(self, n=capture.FRAME_SAMPLES):
            time.sleep(0.005)
            return b"\x01\x00\x00\x00" * n

        def close(self):
            pass

    calls = []

    def fake_open(preferred=None):
        calls.append(1)
        return capture.NullCapture() if len(calls) == 1 else Live()

    monkeypatch.setattr(capture, "open_capture", fake_open)
    monkeypatch.setattr(server, "CAPTURE_RETRY_S", 0.1)
    # The capture gate only opens a recorder while Aura is on and the motion
    # source is audio (see _audio_wanted); a default config is off.
    monkeypatch.setattr(server.config, "load_config",
                        lambda: {"enabled": True, "motion": "both"})
    published = []
    monkeypatch.setattr(server, "publish_config", lambda: published.append(1))
    stop = threading.Event()
    worker = threading.Thread(target=server._capture_loop, args=(stop,), daemon=True)
    worker.start()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        with server._STATE.lock:
            if server._STATE.capture_name == "pulse":
                break
        time.sleep(0.02)
    stop.set()
    worker.join(2)
    with server._STATE.lock:
        assert server._STATE.capture_name == "pulse"
    assert len(calls) == 2
    assert published, "open pages must learn the new capture backend"
