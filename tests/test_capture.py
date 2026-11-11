"""Capture tests: probe order, null fallback, process lifecycle, real loopback.

The real-capture test only runs when this machine has a PipeWire/Pulse monitor;
otherwise it skips with the reason printed. It captures ~0.5 s and reports the
byte count, so "captured" is distinguishable from "started but silent".
"""

from __future__ import annotations

import sys
import threading
import time

import pytest

from aura_core import capture
from aura_core.capture import base


def test_probe_order_is_the_contract_order():
    results = capture.probe_backends()
    names = [entry["name"] for entry in results]
    assert names == ["pipewire", "pulse", "wasapi", "macos", "none"]
    assert results[-1]["available"] is True
    for entry in results:
        assert isinstance(entry["available"], bool)
        assert isinstance(entry["reason"], str)


def test_probe_never_raises_even_if_a_backend_is_broken(monkeypatch):
    from aura_core.capture import pipewire, pulse

    def boom(cls):
        raise RuntimeError("nope")

    monkeypatch.setattr(pipewire.PipeWireCapture, "probe", classmethod(boom))
    monkeypatch.setattr(pulse.PulseCapture, "probe", classmethod(boom))
    results = capture.probe_backends()
    assert [e["name"] for e in results] == ["pipewire", "pulse", "wasapi", "macos", "none"]
    assert results[0]["available"] is False
    assert results[1]["available"] is False
    assert results[-1]["available"] is True


def test_null_capture_returns_silence_frames():
    null = capture.NullCapture()
    frame = null.read(1024)
    assert frame == b"\x00" * 4096
    assert len(frame) == 4096
    null.close()
    assert null.read(1024) is None


def test_open_capture_honours_env_override(monkeypatch):
    monkeypatch.setenv("AURA_CAPTURE", "none")
    cap = capture.open_capture()
    assert cap.name == "none"
    assert isinstance(cap, capture.NullCapture)
    assert cap.read(64) == b"\x00" * 256
    cap.close()


def test_open_capture_falls_back_to_none_when_nothing_is_available(monkeypatch):
    from aura_core.capture import pipewire, pulse

    monkeypatch.delenv("AURA_CAPTURE", raising=False)
    monkeypatch.setattr(pipewire.PipeWireCapture, "probe",
                        classmethod(lambda cls: (False, "disabled")))
    monkeypatch.setattr(pulse.PulseCapture, "probe",
                        classmethod(lambda cls: (False, "disabled")))
    cap = capture.open_capture(preferred="pipewire")
    assert cap.name == "none"
    cap.close()


def test_process_capture_reads_and_restarts_without_zombie():
    """Child writes 10 frames then exits; the pump must restart it, and close()
    must terminate + wait, leaving no live thread."""
    script = (
        "import sys, time\n"
        "sys.stdout.buffer.write(b'\\x01\\x00\\x00\\x00' * 4096)\n"
        "sys.stdout.buffer.flush()\n"
        "time.sleep(0.05)\n"
        "sys.exit(3)\n"
    )
    cap = base.ProcessCapture([sys.executable, "-c", script], restart_limit=5).start()
    try:
        first = cap.read(1024)
        assert first is not None and len(first) == 4096
        assert first[:4] == b"\x01\x00\x00\x00"
        # Wait long enough for at least one restart to happen.
        deadline = time.time() + 3
        restarted = False
        while time.time() < deadline:
            frame = cap.read(1024)
            if frame is not None and len(frame) == 4096:
                restarted = True
                break
        assert restarted, "capture pump did not recover after the child exited"
    finally:
        cap.close()
    assert cap._thread is not None and not cap._thread.is_alive()
    assert cap.read(1024) is None


def test_process_capture_close_is_idempotent():
    cap = base.ProcessCapture([sys.executable, "-c", "import time; time.sleep(10)"]).start()
    time.sleep(0.2)
    cap.close()
    cap.close()
    assert not cap._thread.is_alive()


# ---------------------------------------------------------------------------
# real loopback
# ---------------------------------------------------------------------------

def test_real_loopback_capture_half_second():
    backend = capture.best_backend()
    reasons = {e["name"]: e["reason"] for e in capture.probe_backends()}
    if backend == "none":
        reason = reasons.get("pipewire") or reasons.get("pulse") or "no backend available"
        print(f"SKIP real loopback: {reason}")
        pytest.skip(f"no capture backend on this machine: {reason}")

    cap = capture.open_capture(backend)
    try:
        assert cap.name in ("pipewire", "pulse", "wasapi", "macos")
        started = time.monotonic()
        total_bytes = 0
        frames = 0
        while time.monotonic() - started < 0.5:
            frame = cap.read(1024)
            if frame is None:
                continue
            assert len(frame) == 4096
            total_bytes += len(frame)
            frames += 1
        print(f"captured {total_bytes} bytes ({frames} frames, "
              f"{total_bytes / 4 / 48000:.3f}s mono 48k) via {cap.name}")
        assert total_bytes > 0, "backend started but returned no audio at all"
        assert total_bytes % 4 == 0
    finally:
        cap.close()
    # The capture object must be fully torn down (no lingering pump thread).
    thread = getattr(cap, "_thread", None)
    if thread is not None:
        assert not thread.is_alive()


def test_default_monitor_shape():
    monitor = base.default_monitor()
    if monitor is not None:
        assert isinstance(monitor, str) and ".monitor" in monitor
        print(f"default monitor: {monitor}")
    else:
        print("no monitor source on this machine")
