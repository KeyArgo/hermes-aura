"""Per-turn profile routing: a gateway turn's mood must reach that profile's server.

Hermes's gateway is one process serving several profiles; during a turn it sets
a context-local home override (``hermes_constants.set_hermes_home_override``).
Aura must resolve the *current* home at call time and forward to that home's
leader instead of publishing to its own (root) server. These cases run real
subprocesses with capture off and a fake ``hermes_constants`` module.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

HELPER = r'''
import json
import os
import sys
import time
import types
import urllib.request
from contextvars import ContextVar
from pathlib import Path

MODE = sys.argv[1]
ROOT = sys.argv[2]
OVERRIDE = os.environ.get("AURA_TEST_OVERRIDE_HOME") or None
sys.path.insert(0, ROOT)

_UNSET = object()
_OVERRIDE = ContextVar("_HERMES_HOME_OVERRIDE", default=_UNSET)


def set_hermes_home_override(path):
    return _OVERRIDE.set(_UNSET if path is None else str(path))


def get_hermes_home_override():
    value = _OVERRIDE.get()
    return str(value) if value is not _UNSET and value else None


def get_hermes_home():
    override = get_hermes_home_override()
    if override:
        return Path(override).expanduser()
    raw = os.environ.get("HERMES_HOME")
    return Path(raw).expanduser() if raw else Path("~/.hermes").expanduser()


fake = types.ModuleType("hermes_constants")
fake.set_hermes_home_override = set_hermes_home_override
fake.get_hermes_home_override = get_hermes_home_override
fake.get_hermes_home = get_hermes_home
sys.modules["hermes_constants"] = fake

import aura_core.server as server


def emit(tag, obj):
    print(tag, json.dumps(obj), flush=True)


def get_state(port, token):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/state",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=1.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_mood(port, token, want, deadline=1.0):
    end = time.time() + deadline
    last = None
    while time.time() < end:
        try:
            last = get_state(port, token).get("mood")
        except Exception:
            last = None
        if last == want:
            return last
        time.sleep(0.05)
    return last


server.ensure_server()
port = server.get_port()
token = server.get_token()
emit("READY", {"pid": os.getpid(), "port": port, "token": token})

if MODE == "leader":
    while True:
        time.sleep(1)

if MODE == "override_publish":
    set_hermes_home_override(OVERRIDE)
    server.publish_mood("thinking")
    emit("PUBLISHED", {})
    own = wait_mood(port, token, "thinking", 1.0)
    emit("LOCAL", {"mood": own})
    while True:
        time.sleep(1)

if MODE == "local_publish":
    server.publish_mood("thinking")
    emit("PUBLISHED", {})
    own = wait_mood(port, token, "thinking", 1.0)
    emit("LOCAL", {"mood": own})
    while True:
        time.sleep(1)

if MODE == "override_ensure":
    set_hermes_home_override(OVERRIDE)
    server.ensure_server()
    server.publish_mood("thinking")
    emit("OVERRIDE", {"port": server.get_port(), "token": server.get_token()})
    while True:
        time.sleep(1)
'''


def _spawn(tmp_path: Path, home: Path, mode: str, override: Path | None = None) -> subprocess.Popen:
    script = tmp_path / "aura_home_helper.py"
    if not script.exists():
        script.write_text(HELPER, encoding="utf-8")
    env = dict(os.environ)
    env["HERMES_HOME"] = str(home)
    env["AURA_CAPTURE"] = "none"
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONUNBUFFERED"] = "1"
    if override is not None:
        env["AURA_TEST_OVERRIDE_HOME"] = str(override)
    log = open(tmp_path / f"helper-{mode}.err", "w+", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, str(script), mode, str(ROOT)],
        cwd=str(ROOT), env=env, stdout=subprocess.PIPE,
        stderr=log, text=True, bufsize=1,
    )
    proc._aura_stderr = log
    _SPAWNED.append(proc)
    return proc


def _reader(proc: subprocess.Popen) -> queue.Queue:
    lines: queue.Queue = queue.Queue()

    def run() -> None:
        try:
            for line in proc.stdout:
                lines.put(line.strip())
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=run, daemon=True).start()
    return lines


_SPAWNED: list = []


def _next(lines: queue.Queue, timeout: float) -> dict:
    try:
        line = lines.get(timeout=timeout)
    except queue.Empty:
        tail = ""
        for proc in reversed([p for p in _SPAWNED if p.poll() is not None][-2:]):
            log = getattr(proc, "_aura_stderr", None)
            try:
                if log is not None:
                    log.flush()
                    log.seek(0)
                    tail = log.read()[-1500:]
            except Exception:  # noqa: BLE001
                tail = ""
        pytest.fail("helper produced no line within %.1fs%s" % (
            timeout, (" — helper stderr:\n" + tail) if tail else ""))
    tag, _, raw = line.partition(" ")
    return {"tag": tag, "data": json.loads(raw)}


def _stop(*procs: subprocess.Popen) -> None:
    for proc in procs:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    for proc in procs:
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass


def _state(port: int, token: str) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/state",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=1.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _wait_state(port: int, token: str, want: str, timeout: float) -> str | None:
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = _state(port, token).get("mood")
        except Exception:  # noqa: BLE001
            last = None
        if last == want:
            return last
        time.sleep(0.05)
    return last


def _listen_count(port: int) -> int:
    count = 0
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            rows = Path(path).read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            parts = row.split()
            if len(parts) < 4 or parts[3] != "0A":
                continue
            try:
                local_port = int(parts[1].split(":")[1], 16)
            except (IndexError, ValueError):
                continue
            if local_port == port:
                count += 1
    return count


@pytest.fixture()
def homes(tmp_path):
    profile = tmp_path / "profile"
    root = tmp_path / "root"
    profile.mkdir()
    root.mkdir()
    return {"profile": profile, "root": root}


def test_override_publishes_to_profile_leader(tmp_path, homes):
    leader = _spawn(tmp_path, homes["profile"], "leader")
    other = None
    try:
        a = _next(_reader(leader), 10.0)
        assert a["tag"] == "READY"
        a_port, a_token = a["data"]["port"], a["data"]["token"]
        assert a_port and a_token

        other = _spawn(tmp_path, homes["root"], "override_publish", homes["profile"])
        oq = _reader(other)
        b = _next(oq, 10.0)
        assert b["tag"] == "READY"
        b_port, b_token = b["data"]["port"], b["data"]["token"]
        assert b_port and b_token and b_port != a_port

        assert _next(oq, 5.0)["tag"] == "PUBLISHED"
        assert _wait_state(a_port, a_token, "thinking", 1.0) == "thinking"

        local = _next(oq, 5.0)
        assert local["tag"] == "LOCAL"
        assert local["data"]["mood"] != "thinking"
    finally:
        _stop(leader, *([other] if other else []))


def test_without_override_publish_stays_local(tmp_path, homes):
    leader = _spawn(tmp_path, homes["profile"], "leader")
    other = None
    try:
        a = _next(_reader(leader), 10.0)
        assert a["tag"] == "READY"
        a_port, a_token = a["data"]["port"], a["data"]["token"]

        other = _spawn(tmp_path, homes["root"], "local_publish")
        oq = _reader(other)
        b = _next(oq, 10.0)
        assert b["tag"] == "READY"
        b_port, b_token = b["data"]["port"], b["data"]["token"]
        assert b_port and b_port != a_port

        assert _next(oq, 5.0)["tag"] == "PUBLISHED"
        assert _wait_state(b_port, b_token, "thinking", 1.0) == "thinking"
        assert _state(a_port, a_token).get("mood") != "thinking"

        local = _next(oq, 5.0)
        assert local["tag"] == "LOCAL"
        assert local["data"]["mood"] == "thinking"
    finally:
        _stop(leader, *([other] if other else []))


def test_override_never_starts_a_second_server(tmp_path, homes):
    leader = _spawn(tmp_path, homes["profile"], "leader")
    other = None
    try:
        a = _next(_reader(leader), 10.0)
        assert a["tag"] == "READY"
        a_port, a_token = a["data"]["port"], a["data"]["token"]

        other = _spawn(tmp_path, homes["root"], "override_ensure", homes["profile"])
        oq = _reader(other)
        b = _next(oq, 10.0)
        assert b["tag"] == "READY"
        b_port, b_token = b["data"]["port"], b["data"]["token"]
        assert b_port and b_port != a_port

        over = _next(oq, 5.0)
        assert over["tag"] == "OVERRIDE"
        # Under the override the process reports the profile leader, not itself.
        assert over["data"]["port"] == a_port
        assert over["data"]["token"] == a_token
        assert _wait_state(a_port, a_token, "thinking", 1.0) == "thinking"
        assert _state(b_port, b_token).get("mood") != "thinking"

        # Exactly the two expected listeners (one per process), never a third.
        assert _listen_count(a_port) == 1
        assert _listen_count(b_port) == 1
    finally:
        _stop(leader, *([other] if other else []))
