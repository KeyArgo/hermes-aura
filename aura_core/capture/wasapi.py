"""Windows WASAPI loopback capture via sounddevice.

``WasapiSettings(loopback=True)`` captures the default output device's stream
without any extra native helper. If sounddevice (or PortAudio) is missing, or
the platform is not Windows, the backend reports itself unavailable and the
server falls back to ``none`` — never a hard failure.
"""

from __future__ import annotations

import logging
import sys

from . import base
from .sd_common import SoundDeviceCapture, import_sounddevice

logger = logging.getLogger("aura.capture.wasapi")


class WasapiCapture(SoundDeviceCapture):
    name = "wasapi"

    @classmethod
    def probe(cls) -> tuple[bool, str]:
        if sys.platform != "win32":
            return False, f"not Windows ({sys.platform})"
        sd = import_sounddevice()
        if sd is None:
            return False, "sounddevice not installed"
        try:
            sd.query_devices(kind="output")
        except Exception as exc:  # noqa: BLE001
            return False, f"no output device ({type(exc).__name__})"
        return True, "WASAPI loopback on default output"

    @classmethod
    def open(cls) -> "WasapiCapture":
        sd = import_sounddevice()
        if sd is None:
            raise base.CaptureError("sounddevice not installed")
        try:
            settings = sd.WasapiSettings(loopback=True)  # type: ignore[call-arg]
        except Exception as exc:  # noqa: BLE001 - older sounddevice: no loopback flag
            raise base.CaptureError(f"WasapiSettings(loopback) unavailable: {exc}")
        return cls(device=None, extra_settings=settings).start()
