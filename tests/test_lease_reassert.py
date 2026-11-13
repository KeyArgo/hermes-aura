"""The leader keeps its own lease and token file current.

The lease is how every other reader finds the live server: a follower module in the
same process, the CLI, the tools. If another process overwrites it (a short-lived
command that won the election in a gap and then exited), the real leader used to
advertise only once, at start, so the file kept naming a dead pid and port. Readers
then had no port at all while the leader went on serving.
"""

from __future__ import annotations

import json
import time

import pytest

from aura_core import config
from aura_core import server


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.setattr(server, "LEASE_CHECK_S", 0.2, raising=False)
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token}
    finally:
        server.stop_server()


def _foreign_lease():
    return {"pid": 999999, "port": 1, "token": "someone-else", "started": 0.0, "capture": "none"}


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_leader_restores_a_lease_another_process_overwrote(live):
    config.write_lease(_foreign_lease())

    def restored():
        lease = config.read_lease() or {}
        return lease.get("port") == live["port"] and lease.get("token") == live["token"]

    assert _wait_for(restored), "the leader never re-advertised itself over a foreign lease"


def test_leader_restores_its_token_file(live):
    config.write_token("stale-token-from-another-server")

    assert _wait_for(lambda: config.read_token() == live["token"]), \
        "the token file kept a token the live server rejects"


def test_a_follower_never_rewrites_the_lease(live, monkeypatch):
    foreign = _foreign_lease()
    monkeypatch.setattr(server, "_LOCK_FD", None)
    monkeypatch.setattr(server, "_WIN_MUTEX", None)
    monkeypatch.setattr(server, "fcntl", object())  # a host with a real lock primitive
    config.write_lease(foreign)

    assert server._reassert_lease() is False
    assert json.loads(config.lease_path().read_text(encoding="utf-8"))["token"] == foreign["token"]
