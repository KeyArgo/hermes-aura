"""PipeWire loopback capture via ``pw-record`` against a sink monitor."""

from __future__ import annotations

import logging
import shutil

from . import base

logger = logging.getLogger("aura.capture.pipewire")


class PipeWireCapture(base.ProcessCapture):
    name = "pipewire"

    def __init__(self, target: str):
        super().__init__(
            [
                "pw-record",
                "--target", target,
                "--rate", str(base.SAMPLE_RATE),
                "--channels", str(base.CHANNELS),
                "--format", "f32",
                "--raw",
                "-",
            ],
            target=target,
            restart_limit=50,
        )

    # -- probe -------------------------------------------------------------
    @classmethod
    def probe(cls) -> tuple[bool, str]:
        if shutil.which("pw-record") is None:
            return False, "pw-record not found"
        monitor = base.default_monitor()
        if not monitor:
            return False, "no sink monitor (is PipeWire/PulseAudio running?)"
        return True, f"monitor {monitor}"

    @classmethod
    def open(cls) -> "PipeWireCapture":
        monitor = base.default_monitor()
        if not monitor:
            raise base.CaptureError("no sink monitor")
        return cls(monitor).start()
