"""Diagnostics tests: rotating file log, the five-minute sampler, RSS probes.

Run with the shared venv:
    python -m pytest tests/test_diag.py -q
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import threading
import time

import pytest

from aura_core import config, diag, server


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def diag_home(tmp_path, monkeypatch):
    """An isolated HERMES_HOME with the file handler torn down afterwards."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("AURA_LOG_DEBUG", raising=False)
    diag.shutdown()
    try:
        yield tmp_path
    finally:
        diag.shutdown()


def aura_handlers():
    return [h for h in logging.getLogger("aura").handlers
            if isinstance(h, logging.handlers.RotatingFileHandler)]


def read_log(home):
    return (home / "aura" / "aura.log").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# the rotating file handler
# ---------------------------------------------------------------------------

def test_log_lives_in_data_dir_rotating_1mb_x3(diag_home):
    handler = diag.setup_logging()
    assert handler is not None
    assert isinstance(handler, logging.handlers.RotatingFileHandler)
    assert handler.maxBytes == 1024 * 1024
    assert handler.backupCount == 3
    assert os.path.abspath(handler.baseFilename) == os.path.abspath(str(diag.log_path()))
    assert str(diag.log_path()).startswith(str(diag_home))
    logging.getLogger("aura.server").info("aura: hello from the test")
    handler.flush()
    assert "hello from the test" in read_log(diag_home)


def test_info_by_default_debug_off(diag_home):
    handler = diag.setup_logging()
    assert handler is not None
    assert handler.level == logging.INFO
    assert logging.getLogger("aura").level == logging.INFO
    log = logging.getLogger("aura.server")
    log.debug("aura: debug must not land in the file")
    log.info("aura: info must land in the file")
    handler.flush()
    text = read_log(diag_home)
    assert "info must land" in text
    assert "debug must not" not in text


def test_debug_opt_in_param_and_env(diag_home, monkeypatch):
    handler = diag.setup_logging(debug=True)
    assert handler is not None
    assert handler.level == logging.DEBUG
    logging.getLogger("aura.server").debug("aura: debug now visible")
    handler.flush()
    assert "debug now visible" in read_log(diag_home)
    # The env override is the owner's switch; a fresh setup honours it.
    diag.shutdown()
    monkeypatch.setenv("AURA_LOG_DEBUG", "1")
    handler = diag.setup_logging()
    assert handler is not None
    assert handler.level == logging.DEBUG


def test_setup_is_idempotent(diag_home):
    first = diag.setup_logging()
    second = diag.setup_logging()
    assert first is second
    assert len(aura_handlers()) == 1


def test_rotation_actually_rotates(diag_home):
    handler = diag.setup_logging()
    assert handler is not None
    # Shrink the bound for the test only; the wiring under test is the same.
    handler.maxBytes = 1024
    log = logging.getLogger("aura.server")
    for i in range(40):
        log.info("aura: rotation filler line %03d %s", i, "x" * 60)
    handler.flush()
    assert (diag_home / "aura" / "aura.log.1").exists()
    assert len(aura_handlers()) == 1


def test_token_never_reaches_the_file(diag_home):
    handler = diag.setup_logging()
    assert handler is not None
    token = "secret-token-abcdef123456"
    logging.getLogger("aura.server").info("aura: open http://127.0.0.1:1/?token=%s", token)
    handler.flush()
    text = read_log(diag_home)
    assert token not in text
    assert "token=secr" in text  # masked first4…last4, not the raw value


def test_setup_repoints_when_home_changes(diag_home, tmp_path, monkeypatch):
    first = diag.setup_logging()
    assert first is not None
    logging.getLogger("aura.server").info("aura: written in home one")
    first.flush()
    other = tmp_path / "other-home"
    monkeypatch.setenv("HERMES_HOME", str(other))
    second = diag.setup_logging()
    assert second is not None
    assert second is not first
    assert len(aura_handlers()) == 1
    assert str(diag.log_path()).startswith(str(other))
    logging.getLogger("aura.server").info("aura: written in home two")
    second.flush()
    assert "written in home two" in read_log(other)
    assert "written in home two" not in read_log(diag_home)


def test_setup_survives_an_unwritable_dir(diag_home, monkeypatch):
    def boom():
        raise OSError("read-only filesystem")
    monkeypatch.setattr(config, "_ensure_dir", boom)
    assert diag.setup_logging() is None  # never raises, never breaks the server


# ---------------------------------------------------------------------------
# RSS probes
# ---------------------------------------------------------------------------

def test_parse_proc_status():
    text = "Name:\tpython\nVmPeak:\t 99999 kB\nVmRSS:\t 12345 kB\nThreads:\t7\n"
    assert diag._parse_proc_status(text) == 12345 * 1024
    assert diag._parse_proc_status("no rss here") is None
    assert diag._parse_proc_status("VmRSS:\t junk kB") is None


def test_process_rss_on_this_host():
    value = diag.process_rss()
    if sys.platform.startswith("linux"):
        # /proc is always readable for self on Linux; a None here is a bug.
        assert isinstance(value, int) and value > 0
    else:
        assert value is None or (isinstance(value, int) and value > 0)


def test_rss_unknown_when_every_probe_fails(monkeypatch):
    def boom():
        raise OSError("probe exploded")
    monkeypatch.setattr(diag, "_rss_psutil", boom)
    monkeypatch.setattr(diag, "_rss_native", boom)
    assert diag.process_rss() is None
    assert diag.fmt_rss(None) == "unknown"
    assert diag.fmt_rss(10 * 1024 * 1024) == "10.0MB"


def test_native_dispatch_per_os(monkeypatch):
    monkeypatch.setattr(diag.sys, "platform", "linux")
    monkeypatch.setattr(diag, "_rss_proc", lambda: 111)
    assert diag._rss_native() == 111
    monkeypatch.setattr(diag.sys, "platform", "darwin")
    monkeypatch.setattr(diag, "_rss_macos", lambda: 222)
    assert diag._rss_native() == 222
    monkeypatch.setattr(diag.sys, "platform", "win32")
    monkeypatch.setattr(diag.os, "name", "nt")
    monkeypatch.setattr(diag, "_rss_windows", lambda: 333)
    assert diag._rss_native() == 333
    monkeypatch.setattr(diag.sys, "platform", "sunos5")
    monkeypatch.setattr(diag.os, "name", "posix")
    assert diag._rss_native() is None


def test_windows_probe_is_guarded_off_windows():
    if os.name != "nt":
        assert diag._rss_windows() is None


# ---------------------------------------------------------------------------
# the sampler
# ---------------------------------------------------------------------------

class FakeEvent:
    """A stop event that records every wait timeout, then stops."""

    def __init__(self, false_times):
        self.waits = []
        self.remaining = false_times

    def wait(self, timeout):
        self.waits.append(timeout)
        if self.remaining > 0:
            self.remaining -= 1
            return False
        return True


def test_sampler_interval_is_at_least_five_minutes():
    assert diag.DIAG_INTERVAL_S >= 300
    assert diag.DiagSampler().interval_s >= 300
    # No caller can make it chatty, not even by accident.
    assert diag.DiagSampler(interval_s=1).interval_s >= 300
    assert diag.DiagSampler(interval_s="junk").interval_s >= 300


def test_sampler_run_waits_the_full_interval():
    sampler = diag.DiagSampler()
    event = FakeEvent(false_times=3)
    sampler.run(event)
    assert len(event.waits) == 4  # one wait per sample, including the last
    assert all(w >= 300 for w in event.waits), event.waits


def test_sample_line_carries_rss_threads_and_counts(monkeypatch, caplog):
    monkeypatch.setattr(diag, "process_rss", lambda: 50 * 1024 * 1024)
    counts = {"clients": 2, "pcm_q": 3, "event_q": 5, "dropped": 7,
              "commands": 1, "audio_q": 4}
    sampler = diag.DiagSampler(collect=lambda: counts)
    with caplog.at_level(logging.INFO, logger="aura.diag"):
        payload = sampler.sample()
    assert payload["rss"] == 50 * 1024 * 1024
    assert payload["threads"] == threading.active_count()
    lines = [r.getMessage() for r in caplog.records if r.name == "aura.diag"]
    assert len(lines) == 1
    line = lines[0]
    for fragment in ("rss=50.0MB", "threads=", "clients=2", "pcm_q=3",
                     "event_q=5", "dropped=7", "commands=1", "audio_q=4"):
        assert fragment in line, line


def test_collect_failure_never_breaks_a_sample(monkeypatch, caplog):
    monkeypatch.setattr(diag, "process_rss", lambda: 1024 * 1024)

    def boom():
        raise RuntimeError("counts unavailable")
    sampler = diag.DiagSampler(collect=boom)
    with caplog.at_level(logging.INFO, logger="aura.diag"):
        payload = sampler.sample()
    assert payload["rss"] == 1024 * 1024
    assert any("rss=1.0MB" in r.getMessage() for r in caplog.records)


def test_rss_growth_warns_exactly_once(monkeypatch, caplog):
    samples = iter([100 * 1024 * 1024, 120 * 1024 * 1024,
                    160 * 1024 * 1024, 300 * 1024 * 1024])
    monkeypatch.setattr(diag, "process_rss", lambda: next(samples))
    sampler = diag.DiagSampler()
    with caplog.at_level(logging.WARNING, logger="aura.diag"):
        for _ in range(4):
            sampler.sample()
    warnings = [r for r in caplog.records
                if r.levelno == logging.WARNING and "RSS grew" in r.getMessage()]
    assert len(warnings) == 1
    assert "100.0MB" in warnings[0].getMessage()
    assert "160.0MB" in warnings[0].getMessage()


def test_unknown_rss_never_warns(monkeypatch, caplog):
    monkeypatch.setattr(diag, "process_rss", lambda: None)
    sampler = diag.DiagSampler()
    payload = None
    with caplog.at_level(logging.INFO, logger="aura.diag"):
        for _ in range(3):
            payload = sampler.sample()
    assert payload is not None and payload["rss"] is None
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("rss=unknown" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# server wiring
# ---------------------------------------------------------------------------

@pytest.fixture()
def live_diag(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.delenv("AURA_LOG_DEBUG", raising=False)
    diag.shutdown()
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    assert port, "server did not start"
    try:
        yield tmp_path
    finally:
        server.stop_server()
        diag.shutdown()


def test_server_starts_the_sampler_and_writes_the_baseline(live_diag):
    path = diag.log_path()
    assert str(path).startswith(str(live_diag))
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if path.exists() and "aura: diag" in path.read_text(encoding="utf-8"):
            break
        time.sleep(0.05)
    text = path.read_text(encoding="utf-8")
    assert "aura: diag" in text
    line = next(l for l in text.splitlines() if "aura: diag" in l)
    for fragment in ("rss=", "threads=", "clients=", "pcm_q=", "event_q=",
                     "commands=", "audio_q="):
        assert fragment in line, line
    names = [t.name for t in threading.enumerate()]
    assert "aura-diag" in names


def test_server_stop_ends_the_sampler(live_diag):
    with server._STATE.lock:
        thread = server._STATE.diag_thread
    assert thread is not None and thread.is_alive()
    server.stop_server()
    thread.join(timeout=3.0)
    assert not thread.is_alive(), "the diag sampler outlived stop_server"
    with server._STATE.lock:
        assert server._STATE.diag_thread is None


def test_restart_does_not_double_the_sampler(live_diag):
    # The election restarts serving when the http thread dies. Drive that
    # path directly: the stale listener is closed, the OLD stop event is set
    # (so the old capture/lease/diag loops exit), and one new sampler starts.
    with server._STATE.lock:
        old_httpd = server._STATE.httpd
        old_stop = server._STATE.stop_event
        old_diag = server._STATE.diag_thread
    assert old_diag is not None and old_diag.is_alive()
    assert old_httpd is not None
    old_httpd.shutdown()  # let the old serve_forever exit before the restart
    server._start_server()
    assert server.get_port()
    assert old_stop.is_set(), "the restart left the old aux loops' event unset"
    old_diag.join(timeout=3.0)
    assert not old_diag.is_alive(), "the old diag sampler outlived the restart"
    diag_threads = [t for t in threading.enumerate() if t.name == "aura-diag"]
    assert len(diag_threads) == 1, f"{len(diag_threads)} diag samplers after a restart"
