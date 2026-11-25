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
import base64
import json
import os
import socket
import struct
import sys
import threading
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


def ws_connect(port, token):
    """Open the page's WebSocket and return (sock, leftover bytes)."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=5.0)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    sock.sendall((
        f"GET /api/stream?token={token} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("ws handshake closed")
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    if b" 101" not in head.split(b"\r\n", 1)[0]:
        raise RuntimeError("ws handshake refused")
    return sock, rest


def ws_event(frame, offset):
    """One unmasked server frame -> parsed JSON text payload, else None."""
    if frame[0] & 0x0F != 0x1:
        return None
    try:
        return json.loads(frame[offset:].decode("utf-8"))
    except ValueError:
        return None


def ws_collect(sock, frames, start=b""):
    """Append every text event the server pushes until the socket closes."""
    buf = start
    while True:
        try:
            chunk = sock.recv(65536)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
        while len(buf) >= 2:
            length = buf[1] & 0x7F
            offset = 2
            if length == 126:
                if len(buf) < 4:
                    break
                length = struct.unpack(">H", buf[2:4])[0]
                offset = 4
            elif length == 127:
                if len(buf) < 10:
                    break
                length = struct.unpack(">Q", buf[2:10])[0]
                offset = 10
            if len(buf) < offset + length:
                break
            frame, buf = buf[:offset + length], buf[offset + length:]
            event = ws_event(frame, offset)
            if event is not None:
                frames.append(event)


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

if MODE == "foreign_no_leader":
    # A page is open on this home, then a turn enters another profile that has
    # no live lease and publishes there: nothing may reach this home's state or
    # its page.
    sock, rest = ws_connect(port, token)
    frames = []
    threading.Thread(target=ws_collect, args=(sock, frames, rest), daemon=True).start()
    deadline = time.time() + 3.0
    while not frames and time.time() < deadline:
        time.sleep(0.02)
    time.sleep(0.2)
    mark = len(frames)
    set_hermes_home_override(OVERRIDE)
    try:
        audio = server.publish_audio_request("https://example.invalid/other.mp3",
                                            "other profile", "play")
        server.publish_mood("thinking")
        server.publish_config()
        time.sleep(0.8)
        state = get_state(port, token)
    finally:
        set_hermes_home_override(None)
    emit("RESULT", {
        "seen": mark,
        "audio": audio,
        "mood": state.get("mood"),
        "queued": len(state.get("audio_requests") or []),
        "events": [e for e in frames[mark:] if e.get("type") in ("mood", "config")],
    })
    while True:
        time.sleep(1)
'''


# Each helper's stderr goes to a file whose tail is put into a failure message:
# a silent helper (stderr to DEVNULL) hid why it never reported on macOS CI.
_ERR_FILES: list = []


def _helper_errors() -> str:
    tails = []
    for path in _ERR_FILES[-4:]:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if text:
            tails.append(f"{Path(path).name}: {text[-600:]}")
    return " | ".join(tails) or "no stderr"


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
    err = tmp_path / f"helper-{mode}-{len(_ERR_FILES)}.err"
    _ERR_FILES.append(err)
    return subprocess.Popen(
        [sys.executable, str(script), mode, str(ROOT)],
        cwd=str(ROOT), env=env, stdout=subprocess.PIPE,
        stderr=open(err, "w", encoding="utf-8"), text=True, bufsize=1,
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


def _next(lines: queue.Queue, timeout: float) -> dict:
    try:
        line = lines.get(timeout=timeout)
    except queue.Empty:
        pytest.fail("helper produced no line within %.1fs; stderr: %s" % (timeout, _helper_errors()))
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


def test_foreign_home_without_leader_publishes_nothing(tmp_path, homes):
    """Profile B's audio, mood and config must never reach profile A.

    ``_forward_target()`` answered ``None`` both for "publish to this server"
    and for "the other profile has no leader", so a B-scoped publish fell
    through to the home this process serves: A's queue took B's audio request
    and A's pages took B's settings (B's ``enabled=false`` stopped A's
    renderer).
    """
    # B's own settings: Aura off there, and an intensity A does not use.
    b_aura = homes["root"] / "aura"
    b_aura.mkdir(parents=True)
    (b_aura / "config.json").write_text(
        json.dumps({"enabled": False, "mood_reactive": True, "intensity": 0.9,
                    "opacity": 0.9}), encoding="utf-8")

    leader = _spawn(tmp_path, homes["profile"], "foreign_no_leader", homes["root"])
    try:
        lines = _reader(leader)
        ready = _next(lines, 15.0)
        assert ready["tag"] == "READY"
        assert ready["data"]["port"] and ready["data"]["token"]

        result = _next(lines, 15.0)
        assert result["tag"] == "RESULT"
        data = result["data"]
        # The page must have been live before the publish, or the stream check
        # below would pass for the wrong reason.
        assert data["seen"] > 0, "the page received no frame at all"
        leaked = []
        if data["queued"]:
            leaked.append(f"audio queue ({data['queued']}): {data['audio']}")
        if data["mood"] != "idle":
            leaked.append(f"mood: {data['mood']}")
        if data["events"]:
            leaked.append(f"page events: {data['events']}")
        assert not leaked, "profile B reached profile A: " + "; ".join(leaked)
        assert not (b_aura / "lease.json").exists()
    finally:
        _stop(leader)
