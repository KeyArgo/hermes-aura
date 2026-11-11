"""Shared sounddevice stream reader for the Windows/macOS backends.

sounddevice is an optional dependency: it is imported lazily inside probe/open
so that importing this module never fails on a box without it (including the
pure-stdlib test environment). If it is present it brings numpy with it; we only
ever touch ``bytes()``/``tobytes()`` on the callback buffer, never numpy APIs.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Self

from . import base

logger = logging.getLogger("aura.capture.sd")


def import_sounddevice():
    """Return the ``sounddevice`` module, or ``None`` when it is not installed."""
    try:
        import sounddevice  # noqa: F401  (imported for its side effect: availability)
        return sounddevice
    except Exception:  # noqa: BLE001 - missing/broken native lib is just unavailable
        return None


class SoundDeviceCapture:
    """InputStream -> float32 mono 48 kHz frames, bounded and drop-oldest."""

    name = "sounddevice"

    def __init__(self, device, extra_settings=None, rate: int = base.SAMPLE_RATE):
        self.device = device
        self.extra_settings = extra_settings
        self.rate = rate
        self._stream = None
        self._lock = threading.Lock()
        self._data = threading.Condition(self._lock)
        self._buffer = bytearray()
        self._closed = False
        self._error: str | None = None

    def start(self) -> Self:
        sd = import_sounddevice()
        if sd is None:
            raise base.CaptureError("sounddevice not importable")
        kwargs = {}
        if self.extra_settings is not None:
            kwargs["extra_settings"] = self.extra_settings
        stream = sd.InputStream(
            device=self.device,
            channels=base.CHANNELS,
            samplerate=self.rate,
            dtype="float32",
            blocksize=base.FRAME_SAMPLES,
            callback=self._callback,
            **kwargs,
        )
        try:
            stream.start()
        except Exception as exc:  # noqa: BLE001
            # An opened-but-never-started stream still holds the device open.
            try:
                stream.close()
            except Exception:  # noqa: BLE001 - the original error matters more
                pass
            raise base.CaptureError(f"stream start failed: {exc}") from exc
        self._stream = stream
        return self

    def _callback(self, indata, frames, time_info, status):  # noqa: ANN001
        try:
            chunk = bytes(indata)
        except (TypeError, ValueError):
            try:
                chunk = indata.tobytes()
            except Exception:  # noqa: BLE001
                return
        with self._data:
            if self._closed:
                return
            self._buffer.extend(chunk)
            if len(self._buffer) > base.MAX_BUFFERED_BYTES:
                del self._buffer[: len(self._buffer) - base.MAX_BUFFERED_BYTES]
            self._data.notify_all()

    def read(self, n: int = base.FRAME_SAMPLES) -> bytes | None:
        want = max(1, int(n)) * 4
        deadline = time.monotonic() + 0.25
        with self._data:
            while len(self._buffer) < want:
                if self._closed:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._data.wait(remaining)
            if len(self._buffer) < want:
                return None
            out = bytes(self._buffer[:want])
            del self._buffer[:want]
            return out

    def close(self) -> None:
        with self._data:
            self._closed = True
            self._data.notify_all()
        stream = self._stream
        if stream is not None:
            try:
                stream.stop()
            except Exception:  # noqa: BLE001
                pass
            try:
                stream.close()
            except Exception:  # noqa: BLE001
                pass
            self._stream = None
