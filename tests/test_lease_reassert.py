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


def test_lease_watcher_stays_in_the_profile_that_started_the_server(tmp_path, monkeypatch):
    # The gateway serves several profiles from one process; a profile's home is a
    # context-local override. The lease watcher used to start in an empty context,
    # so it resolved the process-wide default home and wrote this server's lease
    # and token into another profile's files (found in review, 11-14).
    import contextvars

    profile_home = tmp_path / "profile-a"
    default_home = tmp_path / "default"
    current = contextvars.ContextVar("aura_test_home", default=None)
    monkeypatch.setattr(config, "_hermes_constants_home", lambda: current.get())
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.setattr(server, "LEASE_CHECK_S", 0.1, raising=False)

    def start():
        current.set(profile_home)
        server.stop_server()
        server.ensure_server()

    contextvars.copy_context().run(start)
    try:
        assert (profile_home / "aura" / "lease.json").is_file(), "the server did not advertise in its own profile"
        time.sleep(0.6)  # several lease checks
        assert not (default_home / "aura" / "lease.json").exists(), \
            "the lease watcher wrote this server's lease into another profile"
        assert not (default_home / "aura" / "token").exists(), \
            "the lease watcher wrote this server's token into another profile"
    finally:
        contextvars.copy_context().run(lambda: (current.set(profile_home), server.stop_server()))


def test_requests_and_capture_read_the_profile_that_started_the_server(tmp_path, monkeypatch):
    # Same class of bug as the lease watcher: request handler threads and the
    # capture loop started in an empty context, so /api/config answered with the
    # default profile's settings instead of this server's profile (11-14).
    import contextvars
    import http.client

    profile_home = tmp_path / "profile-a"
    default_home = tmp_path / "default"
    current = contextvars.ContextVar("aura_test_home2", default=None)
    monkeypatch.setattr(config, "_hermes_constants_home", lambda: current.get())
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setenv("AURA_CAPTURE", "none")

    def start():
        current.set(profile_home)
        config.save_config({**config.load_config(), "intensity": 0.7})
        server.stop_server()
        server.ensure_server()
        return server.get_port(), server.get_token()

    current.set(None)
    config.save_config({**config.load_config(), "intensity": 0.2})  # the default profile
    port, token = contextvars.copy_context().run(start)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/api/config", headers={"Authorization": f"Bearer {token}"})
        body = json.loads(conn.getresponse().read())
        conn.close()
        assert body["intensity"] == 0.7, f"/api/config read another profile (intensity {body['intensity']})"
    finally:
        contextvars.copy_context().run(lambda: (current.set(profile_home), server.stop_server()))
