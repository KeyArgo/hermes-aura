"""Lightweight diagnostics for the Aura server: a rotating log file and a
five-minute health sample (owner ask: catch problems, including memory growth,
on Linux, Windows and macOS).

What lands in ``<HERMES_HOME>/aura/aura.log``:

* Every ``aura.*`` log record at INFO (DEBUG only when explicitly opted in via
  ``AURA_LOG_DEBUG=1`` or ``setup_logging(debug=True)``). The file rotates at
  1 MB and keeps 3 backups, so the worst case on disk is ~4 MB.
* One line every ``DIAG_INTERVAL_S`` (5 minutes, never faster): process RSS,
  thread count, connected WebSocket clients and the queue sizes the server
  keeps. A single WARNING when RSS has grown more than 50% over the first
  sample — the cheap memory-leak canary.

Stdlib only. ``psutil`` is used when it happens to be importable (it is not a
declared dependency); otherwise RSS comes from /proc on Linux, the psapi
working set on Windows and ``resource`` on macOS (peak RSS there). Anything
unexpected degrades to ``unknown`` — diagnostics must never break the server.
Every line passes through ``redact`` like the rest of Aura's logging.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import threading

from . import config, redact

logger = logging.getLogger("aura.diag")

#: One sample per 5 minutes; the sampler refuses to run faster.
DIAG_INTERVAL_S = 300.0
#: RotatingFileHandler bounds: 1 MB per file, 3 backups (~4 MB worst case).
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3
#: Warn once when RSS exceeds the first sample by more than 50%.
RSS_GROWTH_FACTOR = 1.5

_HANDLER: logging.handlers.RotatingFileHandler | None = None


def log_path():
    """The diagnostics log lives in the plugin's data dir, beside the config."""
    return config.aura_dir() / "aura.log"


# ---------------------------------------------------------------------------
# RSS probes (psutil when present, else one native path per OS)
# ---------------------------------------------------------------------------

def _rss_psutil() -> int | None:
    try:
        import psutil  # not a declared dependency; a bonus when the host ships it
    except ImportError:
        return None
    return int(psutil.Process(os.getpid()).memory_info().rss)


def _parse_proc_status(text: str) -> int | None:
    """``VmRSS:  12345 kB`` -> bytes. Pure, so tests can feed it fixtures."""
    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    return int(parts[1]) * 1024
                except ValueError:
                    return None
    return None


def _rss_proc() -> int | None:
    with open("/proc/self/status", encoding="ascii", errors="replace") as fh:
        return _parse_proc_status(fh.read())


def _rss_windows() -> int | None:
    """The psapi working set — Windows' counterpart of RSS."""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
    if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(),
                                      ctypes.byref(counters), counters.cb):
        return None
    return int(counters.WorkingSetSize)


def _rss_macos() -> int | None:
    """``ru_maxrss`` is bytes on Darwin. It is peak RSS, not current — the
    stdlib offers nothing closer, and a growing peak still catches a leak."""
    import resource
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def _rss_native() -> int | None:
    if sys.platform.startswith("linux"):
        return _rss_proc()
    if os.name == "nt":
        return _rss_windows()
    if sys.platform == "darwin":
        return _rss_macos()
    return None


def process_rss() -> int | None:
    """Current RSS in bytes, or ``None`` when no probe works ("unknown")."""
    for probe in (_rss_psutil, _rss_native):
        try:
            value = probe()
        except Exception:  # noqa: BLE001 - a failed probe is just "unknown"
            value = None
        if isinstance(value, int) and value > 0:
            return value
    return None


def fmt_rss(value: int | None) -> str:
    return "unknown" if value is None else f"{value / (1024 * 1024):.1f}MB"


# ---------------------------------------------------------------------------
# the rotating file handler
# ---------------------------------------------------------------------------

class _RedactFilter(logging.Filter):
    """Belt and braces: no token ever reaches the file, whatever the logger."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact.redact_text(record.getMessage())
            record.args = ()
        except Exception:  # noqa: BLE001 - redaction must not drop the line
            pass
        return True


def _debug_opt_in() -> bool:
    return os.environ.get("AURA_LOG_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


def setup_logging(debug: bool | None = None) -> logging.handlers.RotatingFileHandler | None:
    """Attach the rotating file handler to the ``aura`` logger tree.

    Idempotent, and re-points the handler when the resolved home changes (a
    gateway turn can run under another profile). INFO by default; DEBUG is
    off unless asked for. Never raises: a filesystem problem costs the file
    log, not the server.
    """
    global _HANDLER
    if debug is None:
        debug = _debug_opt_in()
    level = logging.DEBUG if debug else logging.INFO
    aura_logger = logging.getLogger("aura")
    try:
        path = log_path()
        if _HANDLER is not None:
            if os.path.abspath(_HANDLER.baseFilename) == os.path.abspath(str(path)):
                _HANDLER.setLevel(level)
                aura_logger.setLevel(level)
                return _HANDLER
            shutdown()  # another home: close the old file before opening this one
        config._ensure_dir()
        handler = logging.handlers.RotatingFileHandler(
            str(path), maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8", delay=True,
        )
    except OSError as exc:
        logger.warning("aura: diag log unavailable (%s); continuing without it", type(exc).__name__)
        return None
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.setLevel(level)
    handler.addFilter(_RedactFilter())
    aura_logger.setLevel(level)
    aura_logger.addHandler(handler)
    _HANDLER = handler
    return handler


def shutdown() -> None:
    """Detach and close the file handler (tests, and home switches)."""
    global _HANDLER
    handler, _HANDLER = _HANDLER, None
    if handler is None:
        return
    try:
        logging.getLogger("aura").removeHandler(handler)
        handler.close()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# the five-minute sampler
# ---------------------------------------------------------------------------

class DiagSampler:
    """One health line per interval; ``collect`` supplies the server's counts.

    The interval is floored at ``DIAG_INTERVAL_S`` — no caller can make this
    chatty. The first sample is the RSS baseline; growth past +50% warns once.
    """

    def __init__(self, collect=None, interval_s=DIAG_INTERVAL_S) -> None:
        try:
            interval = float(interval_s)
        except (TypeError, ValueError):
            interval = DIAG_INTERVAL_S
        self.interval_s = max(DIAG_INTERVAL_S, interval)
        self._collect = collect if callable(collect) else (lambda: {})
        self._baseline: int | None = None
        self._growth_warned = False

    def sample(self) -> dict:
        rss = process_rss()
        try:
            extra = self._collect()
        except Exception:  # noqa: BLE001 - counts are a bonus, never a blocker
            extra = None
        if not isinstance(extra, dict):
            extra = {}
        payload = {"rss": rss, "threads": threading.active_count(), **extra}
        parts = [f"rss={fmt_rss(rss)}", f"threads={payload['threads']}"]
        for key in ("clients", "pcm_q", "event_q", "dropped", "commands", "audio_q"):
            if key in extra:
                parts.append(f"{key}={extra[key]}")
        logger.info("aura: diag %s", " ".join(parts))
        if rss is not None:
            if self._baseline is None:
                self._baseline = rss
            elif not self._growth_warned and rss > self._baseline * RSS_GROWTH_FACTOR:
                self._growth_warned = True
                logger.warning(
                    "aura: diag RSS grew from %s to %s (>50%% over the first sample)"
                    " — possible memory growth",
                    fmt_rss(self._baseline), fmt_rss(rss),
                )
        return payload

    def run(self, stop_event) -> None:
        """Sample once at start (the baseline), then once per interval."""
        while True:
            try:
                self.sample()
            except Exception as exc:  # noqa: BLE001 - diagnostics never crash a thread
                logger.debug("aura: diag sample failed (%s)", type(exc).__name__)
            if stop_event.wait(self.interval_s):
                return
