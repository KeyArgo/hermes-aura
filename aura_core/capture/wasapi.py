"""Windows WASAPI loopback capture.

Primary path: the ``soundcard`` package, which opens the default speaker as a loopback "microphone"
through real WASAPI loopback. Standard PortAudio (and so ``sounddevice``) has no WASAPI loopback, so
``sounddevice`` is only a fallback for builds that add one. If neither works, or the platform is not
Windows, the backend reports itself unavailable and the server falls back to ``none`` — never a hard
failure.
"""

from __future__ import annotations

import logging
import sys
import threading
import warnings
from typing import Self

from . import base
from .sd_common import SoundDeviceCapture, import_sounddevice

logger = logging.getLogger("aura.capture.wasapi")


def import_soundcard():
    """Return the ``soundcard`` module, or ``None`` when it is missing or cannot load."""
    if sys.platform != "win32":
        return None
    try:
        import soundcard  # noqa: F401
        return soundcard
    except Exception:  # noqa: BLE001 - a broken native layer is just "unavailable"
        return None


class SoundcardLoopbackCapture(SoundDeviceCapture):
    """Default-speaker loopback via ``soundcard`` -> float32 mono 48 kHz, bounded, drop-oldest."""

    name = "wasapi"

    def __init__(self, rate: int = base.SAMPLE_RATE):
        super().__init__(device=None, rate=rate)
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()

    def _push(self, chunk: bytes) -> None:
        with self._data:
            if self._closed:
                return
            self._buffer.extend(chunk)
            if len(self._buffer) > base.MAX_BUFFERED_BYTES:
                del self._buffer[: len(self._buffer) - base.MAX_BUFFERED_BYTES]
            self._data.notify_all()

    def _run(self) -> None:
        try:
            import ctypes
            ctypes.windll.ole32.CoInitializeEx(None, 0)  # soundcard needs COM on this thread
        except Exception:  # noqa: BLE001
            pass
        sc = import_soundcard()
        try:
            speaker = sc.default_speaker()
            loop = sc.get_microphone(id=str(speaker.name), include_loopback=True)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # "data discontinuity" warnings are expected on loopback
                with loop.recorder(samplerate=self.rate, channels=2, blocksize=base.FRAME_SAMPLES) as rec:
                    self._ready.set()
                    while not self._closed:
                        data = rec.record(numframes=base.FRAME_SAMPLES)
                        mono = data.mean(axis=1) if getattr(data, "ndim", 1) > 1 else data
                        self._push(mono.astype("float32").tobytes())
        except Exception as exc:  # noqa: BLE001
            self._error = f"{type(exc).__name__}: {exc}"
            logger.warning("soundcard loopback stopped: %s", self._error)
        finally:
            self._ready.set()
            with self._data:
                self._closed = True
                self._data.notify_all()

    def start(self) -> Self:
        self._thread = threading.Thread(target=self._run, name="aura-wasapi-loopback", daemon=True)
        self._thread.start()
        self._ready.wait(5.0)
        if self._error:
            raise base.CaptureError(f"soundcard loopback failed: {self._error}")
        return self

    def close(self) -> None:
        with self._data:
            self._closed = True
            self._data.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


class WasapiCapture(SoundDeviceCapture):
    name = "wasapi"

    @classmethod
    def probe(cls) -> tuple[bool, str]:
        if sys.platform != "win32":
            return False, f"not Windows ({sys.platform})"
        sc = import_soundcard()
        if sc is not None:
            try:
                sc.default_speaker()
                return True, "WASAPI loopback on default output (soundcard)"
            except Exception as exc:  # noqa: BLE001
                return False, f"no output device ({type(exc).__name__})"
        sd = import_sounddevice()
        if sd is None:
            return False, "soundcard not installed"
        try:
            sd.WasapiSettings(loopback=True)  # type: ignore[call-arg]
        except Exception:  # noqa: BLE001
            return False, "soundcard not installed; sounddevice has no WASAPI loopback"
        return True, "WASAPI loopback on default output (sounddevice)"

    @classmethod
    def open(cls) -> "SoundDeviceCapture":
        if import_soundcard() is not None:
            return SoundcardLoopbackCapture().start()
        sd = import_sounddevice()
        if sd is None:
            raise base.CaptureError("soundcard not installed")
        try:
            settings = sd.WasapiSettings(loopback=True)  # type: ignore[call-arg]
        except Exception as exc:  # noqa: BLE001 - stock sounddevice: no loopback flag
            raise base.CaptureError(f"no WASAPI loopback available: {exc}")
        return cls(device=None, extra_settings=settings).start()
