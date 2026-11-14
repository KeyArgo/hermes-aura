"""Session liveness must never signal a process on Windows.

The session-boost reader asks whether each Hermes session's pid is alive. On Windows
``os.kill(pid, 0)`` is not a liveness check: signal 0 is CTRL_C_EVENT, so it sent a console
Ctrl+C to the process group, which killed the Python test run outright and can hit whatever
shares the gateway's console. The Windows branch is reached by patching ``sessions.os`` so the
same case runs in CI on every OS.
"""

from __future__ import annotations

import os
import types

import pytest

from aura_core import sessions


def test_session_liveness_never_signals_on_windows(monkeypatch):
    signalled = []

    def kill(pid, sig):
        signalled.append((pid, sig))
        raise AssertionError("os.kill(pid, 0) is CTRL_C_EVENT on Windows")

    monkeypatch.setattr(sessions, "os", types.SimpleNamespace(name="nt", kill=kill, getpid=os.getpid))
    probe_owner = getattr(sessions, "proc", None)
    if probe_owner is not None:
        monkeypatch.setattr(probe_owner, "pid_alive_windows", lambda pid: pid == 4242)

    assert sessions._pid_alive(4242) is True
    assert sessions._pid_alive(99) is False
    assert signalled == [], "the session reader signalled a process on Windows"


@pytest.mark.skipif(os.name == "nt", reason="the POSIX signal-0 probe is what Windows must not use")
def test_session_liveness_on_posix_uses_signal_zero():
    assert sessions._pid_alive(os.getpid()) is True
    assert sessions._pid_alive(2 ** 22 + 12345) is False
