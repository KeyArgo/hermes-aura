"""Windows leader election: one server per HERMES_HOME via a named kernel mutex.

Windows has no ``flock``. Before this, every process that merely loaded the plugin (a CLI command,
a doctor probe, an app rescan) started its own server and rewrote ``<home>/aura/token``, so the
docked pane and the control tools held a token the live server rejected: every transport command
answered 401 while the film that was already loaded kept playing.

These cases run on any host: the Windows branches are reached by patching ``server.os`` rather than
by requiring Windows, so the same suite proves them in CI on Linux.
"""

from __future__ import annotations

import os
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _server():
    import sys

    sys.path.insert(0, str(ROOT))
    from aura_core import server

    return server


def _windows(monkeypatch, server):
    """Pretend this process is on Windows, with a clean election state."""
    monkeypatch.setattr(server, "os", types.SimpleNamespace(name="nt", getpid=os.getpid))
    monkeypatch.setattr(server, "fcntl", None)
    monkeypatch.setattr(server, "_LOCK_FD", None)
    monkeypatch.setattr(server, "_WIN_MUTEX", None)
    monkeypatch.setattr(server, "_FOLLOWING", False)


def test_mutex_name_is_stable_and_per_home(monkeypatch, tmp_path):
    server = _server()
    from aura_core import config

    home_a = tmp_path / "home-a"
    home_b = tmp_path / "home-b"
    home_a.mkdir()
    home_b.mkdir()

    monkeypatch.setattr(config, "hermes_home", lambda: home_a)
    first = server._win_mutex_name()
    second = server._win_mutex_name()

    monkeypatch.setattr(config, "hermes_home", lambda: home_b)
    other = server._win_mutex_name()

    assert first == second, "the same home must always name the same kernel object"
    assert other != first, "two homes must not share one mutex"
    assert first.startswith("Local\\hermes-aura-")
    assert first.rsplit("-", 1)[-1].isalnum()


def test_acquire_lock_takes_the_named_mutex_on_windows(monkeypatch):
    server = _server()
    _windows(monkeypatch, server)
    calls = []

    def fake_mutex():
        calls.append("acquired")
        return True

    monkeypatch.setattr(server, "_try_acquire_win_mutex", fake_mutex)

    assert server._try_acquire_lock() is True
    assert calls == ["acquired"], "on Windows the lock must be the named mutex, not a free pass"


def test_acquire_lock_reports_a_follower_when_the_mutex_is_taken(monkeypatch):
    server = _server()
    _windows(monkeypatch, server)
    monkeypatch.setattr(server, "_try_acquire_win_mutex", lambda: False)

    assert server._try_acquire_lock() is False


def test_leader_is_false_when_nothing_is_held_on_windows(monkeypatch):
    server = _server()
    _windows(monkeypatch, server)
    monkeypatch.setattr(server._STATE, "httpd", None)

    assert server._is_leader() is False, "no mutex and no server means follower, not leader"


def test_leader_is_true_once_the_mutex_is_held(monkeypatch):
    server = _server()
    _windows(monkeypatch, server)
    monkeypatch.setattr(server, "_WIN_MUTEX", 4242)

    assert server._is_leader() is True


def test_pid_alive_uses_the_openprocess_probe_on_windows(monkeypatch):
    server = _server()
    _windows(monkeypatch, server)
    seen = []

    def fake_probe(pid):
        seen.append(pid)
        return pid == 4242

    monkeypatch.setattr(server, "_pid_alive_windows", fake_probe)

    assert server._pid_alive(4242) is True
    assert server._pid_alive(99) is False
    assert seen == [4242, 99], "os.kill(pid, 0) is CTRL_C_EVENT on Windows, never a liveness check"


@pytest.mark.skipif(os.name == "nt", reason="POSIX probe is what Windows must not use")
def test_pid_alive_still_signals_on_posix():
    server = _server()

    assert server._pid_alive(os.getpid()) is True
    assert server._pid_alive(999999) is False
