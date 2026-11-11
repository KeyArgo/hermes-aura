"""sd_common: the sounddevice stream must be closed if start() fails.

A stream that is created but never started still holds the device. If
``stream.start()`` raises, ``start()`` must close it before propagating, or
every retry leaks one device handle.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aura_core.capture import sd_common  # noqa: E402
from aura_core.capture import base  # noqa: E402


class FakeStream:
    instances: list["FakeStream"] = []

    def __init__(self):
        self.closed = False
        self.started = False
        FakeStream.instances.append(self)

    def start(self):
        self.started = True
        raise OSError("device busy")

    def close(self):
        self.closed = True


def test_start_failure_closes_the_stream(monkeypatch):
    FakeStream.instances = []

    class FakeSd:
        @staticmethod
        def InputStream(**kwargs):
            return FakeStream()

    monkeypatch.setattr(sd_common, "import_sounddevice", lambda: FakeSd())
    cap = sd_common.SoundDeviceCapture(device=None)
    with pytest.raises(base.CaptureError):
        cap.start()
    assert FakeStream.instances, "no stream was created"
    assert FakeStream.instances[0].closed, "start() failure leaked the stream"
