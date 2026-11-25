"""Capture recovery (review finding: the page stayed parked after audio came back).

Two ways a capture loss used to outlive the loss itself, both driven through the
real ``_capture_loop`` with a fake backend swapped in through
``capture.open_capture`` (same shape as ``test_failure_modes.py``):

* (a) the loss heals on the same handle -> pages are never told, so their hard
  ``capture`` blocker keeps the canvas hidden and the render loop parked until
  an unrelated config event arrives. A ``config`` event carrying the live
  capture name is what lifts that blocker (web/aura.js ``syncCaptureFallback``);
* (b) the handle stays dead -> it still carries a real backend name, so the
  retry probe skipped it and capture never reopened.

Run: pytest tests/test_capture_recovery.py
"""

from __future__ import annotations

import array
import math
import threading
import time

import pytest

from aura_core import analysis, server
from aura_core.capture import base as capture

FRAME_PERIOD_S = capture.FRAME_SAMPLES / capture.SAMPLE_RATE


# ---------------------------------------------------------------------------
# fakes / helpers
# ---------------------------------------------------------------------------

def _tone(n: int, freq: float = 440.0, amp: float = 0.5) -> bytes:
    """Loud float32 frame: real PCM the analyser reports a level for."""
    step = 2.0 * math.pi * freq / capture.SAMPLE_RATE
    return array.array("f", [amp * math.sin(step * i) for i in range(n)]).tobytes()


class FakeCapture:
    """Minimal backend: ``read`` is supplied per test, ``name`` looks real."""

    def __init__(self, read, name: str = "pulse"):
        self.name = name
        self._read = read
        self.closed = False

    def read(self, n: int = capture.FRAME_SAMPLES):
        return self._read(n)

    def close(self) -> None:
        self.closed = True


class FakeClient:
    """A connected page as far as the loop is concerned: it records events."""

    def __init__(self):
        self.events = []

    def push_event(self, obj) -> None:
        self.events.append(dict(obj))

    def push_pcm(self, payload: bytes) -> None:
        pass

    def codes(self, code: str) -> list:
        return [e for e in self.events if e.get("code") == code]

    def of_type(self, kind: str) -> list:
        return [e for e in self.events if e.get("type") == kind]


def _reset_state() -> None:
    with server._STATE.lock:
        server._STATE.capture_obj = None
        server._STATE.capture_name = "none"
        server._STATE.features = analysis.silence_features()
        server._STATE.feature_seq = 0
        server._STATE.pcm_seq = 0
        server._STATE.capture_lost_reported = False


def _start_loop(monkeypatch, opener, client):
    """Run the capture loop with ``opener`` as ``open_capture`` and one client.

    ``publish_config`` is left real: the page-side contract is a config event,
    so the test asserts what a page actually receives.
    """
    _reset_state()
    monkeypatch.setattr(capture, "open_capture", opener)
    monkeypatch.setattr(server, "_audio_wanted", lambda: True)
    with server._STATE.lock:
        server._STATE.clients = {client}
    stop = threading.Event()
    worker = threading.Thread(target=server._capture_loop, args=(stop,), daemon=True)
    worker.start()
    return worker, stop


def _stop_loop(worker, stop) -> None:
    stop.set()
    worker.join(2)
    with server._STATE.lock:
        server._STATE.clients = set()
    assert not worker.is_alive()


def _features() -> dict:
    with server._STATE.lock:
        return dict(server._STATE.features)


# ---------------------------------------------------------------------------
# (a) the same handle recovers: the page is told capture is back
# ---------------------------------------------------------------------------

def test_capture_recovery_tells_the_page_audio_is_back(monkeypatch):
    """Good PCM -> loss -> good PCM on the same handle must lift the blocker."""
    opened = time.monotonic()

    def read(n):
        time.sleep(FRAME_PERIOD_S)
        elapsed = time.monotonic() - opened
        if 0.2 <= elapsed < 2.6:
            return None  # the device stops delivering for >2 s
        return _tone(n)

    client = FakeClient()
    worker, stop = _start_loop(monkeypatch, lambda preferred=None: FakeCapture(read), client)
    time.sleep(3.2)
    _stop_loop(worker, stop)

    lost = client.codes("capture_lost")
    assert len(lost) == 1, lost
    assert _features()["level"] > 0.05, "real PCM never reached the analyser again"

    # Without this a page keeps its hard 'capture' blocker: hidden canvas and a
    # parked render loop, until some unrelated config change arrives.
    configs = client.of_type("config")
    assert configs, "the page was never told capture came back"
    assert configs[0]["capture"] == "pulse", configs[0]
    lost_at = client.events.index(lost[0])
    back_at = client.events.index(configs[0])
    assert back_at > lost_at, "recovery must follow the loss, not lead it"


# ---------------------------------------------------------------------------
# (b) the handle stays dead: capture is reopened instead of locked in silence
# ---------------------------------------------------------------------------

def test_dead_handle_is_reopened(monkeypatch):
    """A backend that keeps returning None must be swapped for a fresh one."""
    # A real gap between the loss threshold (2 s) and the retry probe, as on a
    # live host (CAPTURE_RETRY_S is 10 s there): the loss is reported first.
    monkeypatch.setattr(server, "CAPTURE_RETRY_S", 4.0)
    opened = time.monotonic()
    probes = []

    def dead_read(n):
        time.sleep(FRAME_PERIOD_S)
        if time.monotonic() - opened < 0.2:
            return _tone(n)
        return None  # the device is gone for good; the name stays real

    def good_read(n):
        time.sleep(FRAME_PERIOD_S)
        return _tone(n)

    def opener(preferred=None):
        probes.append(time.monotonic())
        return FakeCapture(dead_read if len(probes) == 1 else good_read)

    client = FakeClient()
    worker, stop = _start_loop(monkeypatch, opener, client)
    time.sleep(5.2)
    with server._STATE.lock:
        name = server._STATE.capture_name
        obj = server._STATE.capture_obj
    level = _features()["level"]
    _stop_loop(worker, stop)

    assert len(probes) >= 2, "the dead handle was never reopened"
    assert name == "pulse", name
    assert obj is not None and not isinstance(obj, capture.NullCapture)
    assert level > 0.05, "capture never produced real audio again"
    assert client.codes("capture_lost"), "the loss itself must still be reported"
