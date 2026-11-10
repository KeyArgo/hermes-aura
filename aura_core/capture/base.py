"""Capture backends: probe order, shared process pump, null fallback.

A capture object exposes exactly ``read(n) -> bytes | None`` (n float32 mono
samples, little-endian, 4*n bytes) and ``close()``. ``None`` means "no data
right now"; the server turns that into silence rather than an error.

Linux backends spawn ``pw-record`` / ``parec`` against a sink *monitor*
(loopback of what the machine is playing — never the microphone). The child is
restarted with backoff if it dies, and is always terminated + waited on close,
so no zombie is left behind.

Windows/macOS use ``sounddevice`` when importable; absence is reported, never
raised. Nothing here imports numpy directly (sounddevice brings its own).
"""

from __future__ import annotations

import collections  # noqa: F401  (kept for downstream convenience)
import json
import importlib
import logging
import os
import subprocess
import threading
import time
from typing import Self

logger = logging.getLogger("aura.capture")

SAMPLE_RATE = 48000
CHANNELS = 1
FRAME_SAMPLES = 1024
FRAME_BYTES = FRAME_SAMPLES * 4
# Never buffer more than ~2 s of audio: if the consumer stalls we drop old data.
MAX_BUFFERED_BYTES = SAMPLE_RATE * 4 * 2

PROBE_ORDER = ("pipewire", "pulse", "wasapi", "macos", "none")


class CaptureError(RuntimeError):
    """Raised by a backend that cannot start; ``open_capture`` catches it."""


# ---------------------------------------------------------------------------
# Linux monitor discovery (shared by pipewire/pulse)
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: float = 3.0) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def pactl_monitors() -> list[str]:
    """Monitor source names reported by PulseAudio/PipeWire (may be empty)."""
    names = []
    for line in _run(["pactl", "list", "short", "sources"]).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and ".monitor" in parts[1]:
            names.append(parts[1].strip())
    return names


def _pw_dump_monitors() -> list[str]:
    raw = _run(["pw-dump"], timeout=5.0)
    if not raw:
        return []
    try:
        nodes = json.loads(raw)
    except ValueError:
        return []
    names = []
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        name = node.get("name") or (node.get("info") or {}).get("props", {}).get("node.name")
        if isinstance(name, str) and ".monitor" in name:
            names.append(name)
    return names


def default_monitor() -> str | None:
    """Prefer the default sink's monitor, else the first monitor available."""
    monitors = pactl_monitors()
    if not monitors:
        monitors = _pw_dump_monitors()
    if not monitors:
        return None
    sink = _run(["pactl", "get-default-sink"]).strip()
    if sink and f"{sink}.monitor" in monitors:
        return f"{sink}.monitor"
    return monitors[0]


# ---------------------------------------------------------------------------
# process-backed capture
# ---------------------------------------------------------------------------

class ProcessCapture:
    """Reads float32 mono 48 kHz frames from a child process's stdout.

    ``command`` is the full argv; ``target`` is the monitor name, used only for
    reporting. The pump thread respawns the child when it exits (device change,
    server restart) with capped exponential backoff, and the reader drops the
    oldest audio when the consumer falls behind.
    """

    name = "process"

    def __init__(self, command: list[str], target: str | None = None,
                 restart_limit: int | None = None):
        self.command = list(command)
        self.target = target
        self._proc: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._buffer = bytearray()
        self._data = threading.Condition(self._lock)
        self._restart_limit = restart_limit
        self._restarts = 0
        self._last_error: str | None = None
        self._started = False

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> Self:
        if self._started:
            return self
        self._started = True
        self._thread = threading.Thread(
            target=self._pump, name=f"aura-capture-{self.name}", daemon=True)
        self._thread.start()
        return self

    def _spawn(self) -> subprocess.Popen | None:
        try:
            proc = subprocess.Popen(
                self.command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                bufsize=0,
                close_fds=True,
            )
        except (OSError, ValueError) as exc:
            self._last_error = f"{type(exc).__name__}: {exc}"
            logger.info("aura: %s spawn failed (%s)", self.name, self._last_error)
            return None
        with self._lock:
            self._proc = proc
        return proc

    def _pump(self) -> None:
        backoff = 0.2
        while not self._closed.is_set():
            proc = self._spawn()
            if proc is None:
                if self._closed.wait(backoff):
                    return
                backoff = min(backoff * 2, 5.0)
                continue
            backoff = 0.2
            fd = proc.stdout.fileno() if proc.stdout is not None else None
            try:
                while not self._closed.is_set() and fd is not None:
                    try:
                        chunk = os.read(fd, FRAME_BYTES)
                    except OSError:
                        break
                    if not chunk:
                        break
                    with self._data:
                        self._buffer.extend(chunk)
                        if len(self._buffer) > MAX_BUFFERED_BYTES:
                            del self._buffer[: len(self._buffer) - MAX_BUFFERED_BYTES]
                        self._data.notify_all()
            finally:
                self._reap(proc)
            if self._closed.is_set():
                return
            self._restarts += 1
            if self._restart_limit is not None and self._restarts > self._restart_limit:
                logger.info("aura: %s exited %d times; giving up", self.name, self._restarts)
                return
            self._closed.wait(backoff)

    def _reap(self, proc: subprocess.Popen) -> None:
        """Terminate and wait: never leave a zombie."""
        try:
            if proc.poll() is None:
                proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
        if proc.stdout is not None:
            try:
                proc.stdout.close()
            except OSError:
                pass
        with self._lock:
            if self._proc is proc:
                self._proc = None

    # -- data --------------------------------------------------------------
    def read(self, n: int = FRAME_SAMPLES) -> bytes | None:
        """Return exactly ``n`` float32 samples, or ``None`` if not enough yet."""
        want = max(1, int(n)) * 4
        if self._closed.is_set():
            return None
        deadline = time.monotonic() + 0.25
        with self._data:
            while len(self._buffer) < want:
                if self._closed.is_set():
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
        self._closed.set()
        with self._data:
            self._data.notify_all()
        with self._lock:
            proc = self._proc
        if proc is not None:
            self._reap(proc)
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)

    # -- info --------------------------------------------------------------
    @property
    def last_error(self) -> str | None:
        return self._last_error

    @property
    def restarts(self) -> int:
        return self._restarts


class NullCapture:
    """Always-available silence: the server still serves, features stay zero."""

    name = "none"

    def __init__(self, rate: int = SAMPLE_RATE):
        self.rate = rate
        self._closed = False

    def read(self, n: int = FRAME_SAMPLES) -> bytes | None:
        if self._closed:
            return None
        return b"\x00" * (max(1, int(n)) * 4)

    def close(self) -> None:
        self._closed = True


# ---------------------------------------------------------------------------
# probe / open
# ---------------------------------------------------------------------------

def _backend_classes():
    """Imported lazily so a platform module's import failure cannot break probe."""
    classes = []
    # Package-relative: inside Hermes this package is loaded under the plugin's
    # namespace, not as top-level ``aura_core``; an absolute name fails there
    # and silently leaves no backends at all.
    for module_name, attr in (
        (".pipewire", "PipeWireCapture"),
        (".pulse", "PulseCapture"),
        (".wasapi", "WasapiCapture"),
        (".macos", "MacosCapture"),
    ):
        try:
            mod = importlib.import_module(module_name, __package__)
            classes.append(getattr(mod, attr))
        except Exception as exc:  # noqa: BLE001 - a broken backend is just unavailable
            logger.debug("aura: backend %s import failed (%s)", module_name, type(exc).__name__)
    return classes


def probe_backends() -> list[dict]:
    """Ordered probe: pipewire, pulse, wasapi, macos, none.

    Each entry is ``{"name", "available", "reason"}``. Never raises.
    """
    results = []
    for cls in _backend_classes():
        try:
            available, reason = cls.probe()
        except Exception as exc:  # noqa: BLE001
            available, reason = False, f"probe error: {type(exc).__name__}"
        results.append({"name": cls.name, "available": bool(available), "reason": reason})
    results.append({"name": "none", "available": True, "reason": "silence fallback"})
    return results


def best_backend() -> str:
    """Name of the first available real backend, or ``"none"``."""
    for entry in probe_backends():
        if entry["available"] and entry["name"] != "none":
            return entry["name"]
    return "none"


def open_capture(preferred: str | None = None):
    """Open the best available capture (or ``preferred`` when it is available).

    Returns an object with ``read(n)`` and ``close()``. Never raises: a broken
    backend degrades to ``NullCapture``.
    """
    override = os.environ.get("AURA_CAPTURE", "").strip().lower()
    if override == "none":
        return NullCapture()

    classes = {cls.name: cls for cls in _backend_classes()}
    order = [preferred] if preferred and preferred in classes else []
    order += [name for name in PROBE_ORDER if name in classes and name not in order]

    for name in order:
        cls = classes[name]
        try:
            available, _reason = cls.probe()
        except Exception:  # noqa: BLE001
            available = False
        if not available:
            continue
        try:
            obj = cls.open()
        except Exception as exc:  # noqa: BLE001
            logger.info("aura: %s open failed (%s)", name, type(exc).__name__)
            continue
        # A backend can probe as "available" and still produce nothing (e.g.
        # pw-record cannot find the monitor node on some PipeWire setups).
        # Verify real data before committing; otherwise fall through to the
        # next backend instead of serving silence under a working name.
        deadline = time.monotonic() + 1.2
        while time.monotonic() < deadline:
            try:
                if obj.read(FRAME_SAMPLES):
                    return obj
            except Exception:  # noqa: BLE001
                break
        logger.info("aura: %s produced no audio; trying next backend", name)
        try:
            obj.close()
        except Exception:  # noqa: BLE001
            pass
    return NullCapture()


def backend_available(name: str) -> bool:
    if name == "none":
        return True
    for entry in probe_backends():
        if entry["name"] == name:
            return entry["available"]
    return False
