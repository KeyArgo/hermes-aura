"""macOS capture via sounddevice on a virtual loopback device (e.g. BlackHole).

Core Audio has no plain loopback input; the practical path is a virtual audio
device that the user routes system output into. We look for the usual names
(BlackHole, Loopback, Soundflower) and report unavailable otherwise. No native
helper, no ScreenCaptureKit dependency.
"""

from __future__ import annotations

import logging
import sys

from . import base
from .sd_common import SoundDeviceCapture, import_sounddevice

logger = logging.getLogger("aura.capture.macos")

_VIRTUAL_HINTS = ("blackhole", "loopback", "soundflower", "existential audio")


def _find_virtual_device(sd):
    try:
        devices = sd.query_devices()
    except Exception:  # noqa: BLE001
        return None
    for index, dev in enumerate(devices if isinstance(devices, list) else []):
        if not isinstance(dev, dict):
            continue
        name = str(dev.get("name", "")).lower()
        if any(hint in name for hint in _VIRTUAL_HINTS) and int(dev.get("max_input_channels", 0)) > 0:
            return index
    return None


class MacosCapture(SoundDeviceCapture):
    name = "macos"

    @classmethod
    def probe(cls) -> tuple[bool, str]:
        if sys.platform != "darwin":
            return False, f"not macOS ({sys.platform})"
        sd = import_sounddevice()
        if sd is None:
            return False, "sounddevice not installed"
        index = _find_virtual_device(sd)
        if index is None:
            return False, "no virtual loopback device (install BlackHole)"
        return True, f"virtual device #{index}"

    @classmethod
    def open(cls) -> "MacosCapture":
        sd = import_sounddevice()
        if sd is None:
            raise base.CaptureError("sounddevice not installed")
        index = _find_virtual_device(sd)
        if index is None:
            raise base.CaptureError("no virtual loopback device")
        return cls(device=index).start()
