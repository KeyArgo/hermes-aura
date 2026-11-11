"""PulseAudio/PipeWire-pulse loopback capture via ``parec`` against a monitor."""

from __future__ import annotations

import logging
import shutil

from . import base

logger = logging.getLogger("aura.capture.pulse")


class PulseCapture(base.ProcessCapture):
    name = "pulse"

    def __init__(self, target: str):
        super().__init__(
            [
                "parec",
                f"--device={target}",
                "--format=float32le",
                f"--rate={base.SAMPLE_RATE}",
                f"--channels={base.CHANNELS}",
                "--client-name=aura",
                "--latency-msec=20",
                "--raw",
            ],
            target=target,
            restart_limit=50,
        )

    # -- probe -------------------------------------------------------------
    @classmethod
    def probe(cls) -> tuple[bool, str]:
        if shutil.which("parec") is None:
            return False, "parec not found"
        monitor = base.default_monitor()
        if not monitor:
            return False, "no sink monitor (is PulseAudio/PipeWire running?)"
        return True, f"monitor {monitor}"

    @classmethod
    def open(cls) -> "PulseCapture":
        monitor = base.default_monitor()
        if not monitor:
            raise base.CaptureError("no sink monitor")
        return cls(monitor).start()
