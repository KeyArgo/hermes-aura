"""A deleted Hermes profile must stay deleted.

The lease watcher runs every couple of seconds and re-writes lease.json and the
token file. Both writes mkdir(parents=True) their directory, so when the user
deleted the profile folder the watcher re-created
~/.hermes/profiles/<name>/aura/ behind their back and Hermes then refused the
profile with "Named profile home does not exist".
"""

from __future__ import annotations

import shutil
import time

import pytest

from aura_core import server


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.setattr(server, "LEASE_CHECK_S", 0.2, raising=False)
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    assert port, "server did not start"
    try:
        yield {"home": tmp_path, "port": port}
    finally:
        server.stop_server()


def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_a_deleted_profile_is_not_recreated_and_the_server_stops(live):
    shutil.rmtree(live["home"])
    assert not live["home"].exists()

    time.sleep(1.5)  # several lease checks

    assert not live["home"].exists(), "the lease watcher re-created the deleted profile home"
    assert _wait_for(lambda: not server.get_port(), timeout=2.0), \
        "the server kept serving after its profile home was deleted"
