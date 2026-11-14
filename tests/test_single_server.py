"""Single-server-per-HERMES_HOME tests: leader election + follower forwarding.

Each case runs real subprocesses against a temp HERMES_HOME with capture off.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

HELPER = r'''
import importlib.util
import json
import os
import sys
import time
import urllib.request

MODE = sys.argv[1]
ROOT = sys.argv[2]
sys.path.insert(0, ROOT)


def emit(tag, obj):
    print(tag, json.dumps(obj), flush=True)


def get_state(port, token):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/state",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=1.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


if MODE == "twocopies":
    import aura_core.server as s1
    spec = importlib.util.spec_from_file_location("aura_core.server_copy", s1.__file__)
    s2 = importlib.util.module_from_spec(spec)
    sys.modules["aura_core.server_copy"] = s2
    spec.loader.exec_module(s2)
    s1.ensure_server()
    s2.ensure_server()
    time.sleep(0.3)
    emit("READY", {
        "port1": s1.get_port(), "token1": s1.get_token(),
        "port2": s2.get_port(), "token2": s2.get_token(),
    })
    while True:
        time.sleep(1)

import aura_core.server as server

server.ensure_server()
port = server.get_port()
token = server.get_token()
emit("READY", {"pid": os.getpid(), "port": port, "token": token})

if MODE in ("leader", "follower_idle"):
    while True:
        time.sleep(1)

if MODE == "follower_publish":
    server.publish_mood("thinking")
    deadline = time.time() + 1.0
    mood = None
    while time.time() < deadline:
        try:
            mood = get_state(port, token).get("mood")
            if mood == "thinking":
                break
        except Exception:
            pass
        time.sleep(0.05)
    emit("MOOD", {"mood": mood})
    while True:
        time.sleep(1)

if MODE == "follower_takeover":
    initial = token
    deadline = time.time() + 10.0
    while time.time() < deadline:
        try:
            server.ensure_server()
        except Exception:
            pass
        new_token = server.get_token()
        if new_token and new_token != initial:
            emit("TAKEOVER", {
                "pid": os.getpid(),
                "port": server.get_port(),
                "token": new_token,
            })
            while True:
                time.sleep(1)
        time.sleep(0.2)
    emit("TIMEOUT", {"token": server.get_token()})
    while True:
        time.sleep(1)
'''


def _spawn(tmp_path: Path, home: Path, mode: str) -> subprocess.Popen:
    script = tmp_path / "aura_helper.py"
    if not script.exists():
        script.write_text(HELPER, encoding="utf-8")
    env = dict(os.environ)
    env["HERMES_HOME"] = str(home)
    env["AURA_CAPTURE"] = "none"
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.Popen(
        [sys.executable, str(script), mode, str(ROOT)],
        cwd=str(ROOT), env=env, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1,
    )


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


def _next(lines: queue.Queue, timeout: float) -> str:
    try:
        return lines.get(timeout=timeout)
    except queue.Empty:
        pytest.fail("helper produced no line within %.1fs" % timeout)


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


def _payload(line: str) -> dict:
    tag, _, raw = line.partition(" ")
    return {"tag": tag, "data": json.loads(raw)}


def _listen_count(port: int) -> int:
    """Listening TCP sockets on ``port``: /proc on Linux, netstat on Windows and macOS.

    Reading only /proc made this 0 everywhere but Linux, so the one-server checks could
    never pass on the other platforms the plugin claims.
    """
    rows = []
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            rows += Path(path).read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
    if rows:
        count = 0
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
    windows = os.name == "nt"
    args = ["netstat", "-ano", "-p", "TCP"] if windows else ["netstat", "-an", "-p", "tcp"]
    out = subprocess.run(args, capture_output=True, text=True, timeout=20, check=True).stdout
    count = 0
    for line in out.splitlines():
        parts = line.split()
        if "LISTEN" not in line.upper() or len(parts) < 4:
            continue
        # Windows: "TCP 127.0.0.1:52345 0.0.0.0:0 LISTENING pid";
        # macOS:   "tcp4 0 0 127.0.0.1.52345 *.* LISTEN".
        local = parts[1] if windows else parts[3]
        if local.rsplit(":" if windows else ".", 1)[-1] == str(port):
            count += 1
    return count


@pytest.fixture()
def home(tmp_path):
    target = tmp_path / "home"
    target.mkdir()
    return target


def test_two_processes_share_one_server(tmp_path, home):
    leader = _spawn(tmp_path, home, "leader")
    follower = None
    try:
        lq = _reader(leader)
        first = _payload(_next(lq, 10.0))
        assert first["tag"] == "READY"
        assert first["data"]["port"], first
        follower = _spawn(tmp_path, home, "follower_idle")
        fq = _reader(follower)
        second = _payload(_next(fq, 10.0))
        assert second["tag"] == "READY"
        assert second["data"]["port"] == first["data"]["port"]
        assert second["data"]["token"] == first["data"]["token"]
        assert _listen_count(first["data"]["port"]) == 1
    finally:
        _stop(leader, *( [follower] if follower else [] ))


def test_two_module_copies_in_one_process(tmp_path, home):
    proc = _spawn(tmp_path, home, "twocopies")
    try:
        payload = _payload(_next(_reader(proc), 10.0))
        assert payload["tag"] == "READY"
        data = payload["data"]
        assert data["port1"] and data["port2"]
        assert data["port1"] == data["port2"]
        assert data["token1"] == data["token2"]
        assert _listen_count(data["port1"]) == 1
    finally:
        _stop(proc)


def test_follower_publish_reaches_leader(tmp_path, home):
    leader = _spawn(tmp_path, home, "leader")
    follower = None
    try:
        first = _payload(_next(_reader(leader), 10.0))
        assert first["tag"] == "READY"
        follower = _spawn(tmp_path, home, "follower_publish")
        fq = _reader(follower)
        ready = _payload(_next(fq, 10.0))
        assert ready["tag"] == "READY"
        assert ready["data"]["port"] == first["data"]["port"]
        mood = _payload(_next(fq, 3.0))
        assert mood["tag"] == "MOOD"
        assert mood["data"]["mood"] == "thinking"
    finally:
        _stop(leader, *( [follower] if follower else [] ))


def test_follower_takes_over_after_leader_dies(tmp_path, home):
    leader = _spawn(tmp_path, home, "leader")
    follower = None
    try:
        first = _payload(_next(_reader(leader), 10.0))
        assert first["tag"] == "READY"
        follower = _spawn(tmp_path, home, "follower_takeover")
        fq = _reader(follower)
        ready = _payload(_next(fq, 10.0))
        assert ready["tag"] == "READY"
        old_token = ready["data"]["token"]
        assert old_token == first["data"]["token"]

        leader.kill()
        leader.wait(timeout=5)

        takeover = _payload(_next(fq, 6.0))
        assert takeover["tag"] == "TAKEOVER", takeover
        new_token = takeover["data"]["token"]
        assert new_token and new_token != old_token
        token_file = (home / "aura" / "token").read_text(encoding="utf-8").strip()
        assert token_file == new_token
        assert _listen_count(takeover["data"]["port"]) == 1
    finally:
        _stop(leader, *( [follower] if follower else [] ))
