"""The Desktop window in Visualizer mode (owner bug).

"Desktop" in Watch in / Send to opened the film page (player.html) even in
Visualizer mode. The window must open the visualiser page (index.html) there,
keep the film in Video mode, swap pages when the mode changes while it is
open, and authenticate with the same one-time ticket as the film window —
never the server token in a URL, an argument or a log.

No browser is ever launched: Popen, browser discovery and the lease are faked
(the test_window.py pattern). The endpoint tests run the real server with the
window itself faked (the test_player.py pattern).
"""

from __future__ import annotations

import http.client
import json
import subprocess
import sys

import pytest

from aura_core import server
from aura_core import window


class FakeProc:
    def __init__(self, pid: int = 4242, exit_immediately: bool = False):
        self.pid = pid
        self.exit_immediately = exit_immediately
        self.returncode = None
        self.args = None
        self.terminated = 0
        self.killed = 0

    def poll(self):
        return 0 if self.exit_immediately else None

    def wait(self, timeout=None):
        if self.exit_immediately:
            self.returncode = 0
            return 0
        raise subprocess.TimeoutExpired(cmd="chrome", timeout=timeout or 1.5)

    def terminate(self):
        self.terminated += 1
        self.exit_immediately = True

    def kill(self):
        self.killed += 1
        self.exit_immediately = True


class FakeThread:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        pass


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(window, "_proc", None)
    monkeypatch.setattr(window, "_closing", None)
    monkeypatch.setattr(window, "_film_url", "")
    monkeypatch.setattr(window, "_kind", "", raising=False)
    monkeypatch.setattr(window, "_screen", "player", raising=False)
    yield


@pytest.fixture
def popen(monkeypatch):
    calls = []

    def fake_popen(args, **kwargs):
        proc = FakeProc()
        proc.args = args
        calls.append((args, kwargs, proc))
        return proc

    monkeypatch.setattr(window.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(window.threading, "Thread", FakeThread)
    monkeypatch.setattr(window, "find_browser", lambda: "/usr/bin/chromium")
    monkeypatch.setattr(window, "_raise_native", lambda pid: False)
    return calls


def _app(args):
    return next(a for a in args if a.startswith("--app="))


# ------------------------------------------------------------- the window


def test_visualizer_url_is_the_visualiser_page_with_a_ticket():
    url = window.visualizer_url(4567, "s3cret")
    assert url.startswith("http://127.0.0.1:4567/index.html?")
    assert "desktop=1" in url
    assert "ticket=s3cret" in url
    assert "player.html" not in url
    assert "token=" not in url


def test_visualizer_url_carries_reduced_motion():
    assert "reduced-motion=1" in window.visualizer_url(4567, "s3cret", reduced_motion=True)
    assert "reduced-motion" not in window.visualizer_url(4567, "s3cret", reduced_motion=False)


def test_open_window_visualizer_opens_the_visualiser_page(popen):
    result = window.open_window(4567, "tok", "", page="visualizer")
    assert result["open"] is True and result["already"] is False
    app = _app(popen[0][0])
    assert app.startswith("--app=http://127.0.0.1:4567/index.html?")
    assert "desktop=1" in app
    assert "player.html" not in app
    assert "url=" not in app, "the visualiser window was handed a film url"
    status = window.status()
    assert status["open"] is True
    assert status["page"] == "visualizer"
    assert status["url"] == "", "the visualiser window claims a film"


def test_visualizer_window_never_leaks_the_token(popen):
    window.open_window(4567, "very-secret-token", "", page="visualizer")
    joined = " ".join(popen[0][0])
    assert "very-secret-token" not in joined
    assert "ticket=" in joined
    assert "very-secret-token" not in json.dumps(window.status())


def test_visualizer_window_needs_no_film(popen):
    # The bug: Visualizer mode with no film loaded refused to pop out at all.
    result = window.open_window(4567, "tok", "", page="visualizer")
    assert result["open"] is True
    assert len(popen) == 1


def test_video_mode_still_opens_the_film(popen):
    window.open_window(4567, "tok", "https://example.test/film.mp4", 12.0)
    app = _app(popen[0][0])
    assert app.startswith("--app=http://127.0.0.1:4567/player.html?")
    assert "t=12" in app
    assert window.status()["page"] == "player"


def test_mode_switch_swaps_the_open_window_both_ways(popen):
    # Visualizer -> Video: the film takes the window (close + reopen cleanly).
    window.open_window(4567, "tok", "", page="visualizer")
    first = popen[0][2]
    result = window.open_window(4567, "tok", "https://example.test/film.mp4")
    assert first.terminated == 1, "the visualiser window was left up under the film"
    assert result["already"] is False
    assert "player.html" in _app(popen[1][0])
    assert window.status()["page"] == "player"
    # Video -> Visualizer: and back.
    second = popen[1][2]
    result = window.open_window(4567, "tok", "", page="visualizer")
    assert second.terminated == 1, "the film window was left up under the visualiser"
    assert result["already"] is False
    assert "index.html" in _app(popen[2][0])
    assert window.status()["page"] == "visualizer"


def test_same_page_twice_reports_already(popen):
    window.open_window(4567, "tok", "", page="visualizer")
    again = window.open_window(4567, "tok", "", page="visualizer")
    assert again["already"] is True
    assert len(popen) == 1, "the same page relaunched the window"


def test_reduced_motion_reaches_the_window(popen):
    window.open_window(4567, "tok", "", page="visualizer", reduced_motion=True)
    assert "reduced-motion=1" in _app(popen[0][0])


# ------------------------------- the profile a restarted server left held (owner bug)
#
# The owner's Desktop click 503'd twice after a backend restart: a window the
# previous server opened survives it (start_new_session), still holds
# ~/.hermes/aura/desktop-browser, and the new launch only forwards to it and
# exits. The launch must free that one pid — and only one that really runs on
# our profile — and try once more.


def _launcher(monkeypatch, exit_first=True):
    """Popen stand-in: the first launch exits at once (a hand-off, not a
    window), later ones stay up."""
    launches = []

    def fake_popen(args, **kwargs):
        proc = FakeProc(pid=5000 + len(launches), exit_immediately=exit_first and not launches)
        proc.args = args
        launches.append(proc)
        return proc

    monkeypatch.setattr(window.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(window.threading, "Thread", FakeThread)
    monkeypatch.setattr(window, "find_browser", lambda: "/usr/bin/google-chrome")
    monkeypatch.setattr(window, "_raise_native", lambda pid: False)
    return launches


def _process_table(monkeypatch, cmdlines):
    """Exactly ``cmdlines``' pids are alive, with those command lines; any
    signal ends them (a window that honours SIGTERM): no real process is used."""
    monkeypatch.setattr(window, "_command_line", lambda pid: cmdlines.get(int(pid), ""))
    alive = set(cmdlines)
    signalled = []

    def record(pid, sig):
        signalled.append((pid, sig))
        alive.discard(pid)

    monkeypatch.setattr(window.os, "killpg", record, raising=False)  # absent on Windows
    monkeypatch.setattr(window.os, "kill", record)
    monkeypatch.setattr(window, "_alive", lambda pid: int(pid) in alive)
    return signalled


def test_orphaned_window_holding_the_profile_is_terminated_and_relaunched(monkeypatch):
    launches = _launcher(monkeypatch)
    profile = window._profile()
    profile.mkdir(parents=True, exist_ok=True)
    window._write_lease(4711, "")  # the previous server's window, still running
    signalled = _process_table(monkeypatch, {
        4711: f"google-chrome\0--app=http://127.0.0.1:4567/index.html\0"
              f"--user-data-dir={profile}\0",
    })
    result = window.open_window(4567, "tok", "", page="visualizer")
    assert result["open"] is True
    assert result["pid"] == 5001, "the window was not relaunched once the profile was free"
    assert len(launches) == 2, "the launch was not retried exactly once"
    assert [pid for pid, _sig in signalled] == [4711], "the orphan was not terminated"
    assert signalled[0][1] == window.signal.SIGTERM
    assert window.status()["open"] is True


def test_the_relaunch_carries_a_fresh_ticket(monkeypatch):
    # The hand-off may have shown the first address in the orphan, spending its
    # one-time ticket; the relaunch must not repeat a ticket that is already used.
    launches = _launcher(monkeypatch)
    profile = window._profile()
    profile.mkdir(parents=True, exist_ok=True)
    window._write_lease(4711, "")
    _process_table(monkeypatch, {
        4711: f"google-chrome\0--user-data-dir={profile}\0",
    })
    window.open_window(4567, "tok", "", page="visualizer")
    first, second = (_app(proc.args) for proc in launches)
    assert first != second, "the relaunch reused the first launch's ticket"
    ticket = second.split("ticket=", 1)[1].split("&", 1)[0]
    assert window.ticket_valid(ticket) is True


@pytest.mark.skipif(sys.platform == "win32", reason="Windows keeps no SingletonLock link")
def test_the_profile_lock_finds_an_orphan_with_no_lease(monkeypatch):
    # The lease is one witness; Chromium's own profile lock is the other, and
    # it is the one that knows about a window whose lease was never written.
    launches = _launcher(monkeypatch)
    profile = window._profile()
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "SingletonLock").symlink_to("aura-host-4712")
    signalled = _process_table(monkeypatch, {
        4712: f"google-chrome\0--app=http://127.0.0.1:4567/index.html\0"
              f"--user-data-dir={profile}\0",
    })
    result = window.open_window(4567, "tok", "", page="visualizer")
    assert result["open"] is True
    assert [pid for pid, _sig in signalled] == [4712]
    assert len(launches) == 2


def test_a_pid_that_is_not_ours_is_never_touched(monkeypatch):
    # PIDs get reused: the lease can name a live process that has nothing to do
    # with Aura. Its command line is the proof required before any signal.
    launches = _launcher(monkeypatch)
    window._profile().mkdir(parents=True, exist_ok=True)
    window._write_lease(4711, "")
    signalled = _process_table(monkeypatch, {
        4711: "firefox\0--user-data-dir=/home/dev/.mozilla/firefox\0https://example.test",
    })
    with pytest.raises(window.WindowError) as raised:
        window.open_window(4567, "tok", "", page="visualizer")
    assert "exited immediately" in str(raised.value)
    assert signalled == [], "an unrelated process was signalled"
    assert len(launches) == 1, "relaunching could only fail the same way"
    assert window.status()["open"] is False


def test_the_profile_lock_is_not_consulted_on_windows(monkeypatch):
    monkeypatch.setattr(window, "_on_windows", lambda: True)
    assert window._singleton_pid() == 0


def test_ticket_valid_peeks_without_consuming():
    ticket = window.issue_ticket("tok")
    assert window.ticket_valid(ticket) is True
    assert window.ticket_valid(ticket) is True, "peeking consumed the one-time ticket"
    assert window.redeem_ticket(ticket) == "tok"
    assert window.ticket_valid(ticket) is False, "a redeemed ticket still opens the page"
    assert window.ticket_valid("never-issued") is False


def test_ticket_valid_refuses_an_expired_ticket(monkeypatch):
    ticket = window.issue_ticket("tok")
    real_monotonic = window.time.monotonic
    monkeypatch.setattr(window.time, "monotonic",
                        lambda: real_monotonic() + window.TICKET_TTL + 1)
    assert window.ticket_valid(ticket) is False


# ------------------------------------------------------------- the server


@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    server.stop_server()
    server.ensure_server()
    port = server.get_port()
    token = server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token, "home": tmp_path}
    finally:
        server.stop_server()


def call(port, method, path, token=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(data))
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, payload


def test_window_open_visualizer_needs_no_film(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, **kwargs):
        seen.update(port=port, token=token, url=url, kwargs=kwargs)
        return {"open": True, "already": False, "url": url, "pid": 1}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": True, "available": True, "page": "visualizer"})
    status, payload = call(live["port"], "POST", "/api/window/open", live["token"],
                           {"page": "visualizer", "reducedMotion": True})
    body = json.loads(payload.decode("utf-8") or "{}")
    assert status == 200 and body["ok"] is True
    assert seen["kwargs"].get("page") == "visualizer"
    assert seen["kwargs"].get("reduced_motion") is True
    assert seen["url"] == ""
    assert live["token"] not in payload.decode("utf-8")


def test_window_open_defaults_to_the_film(live, monkeypatch):
    seen = {}

    def fake_open(port, token, url, **kwargs):
        seen.update(url=url, kwargs=kwargs)
        return {"open": True, "already": False, "url": url, "pid": 1}

    monkeypatch.setattr(server.desktop_window, "open_window", fake_open)
    monkeypatch.setattr(server.desktop_window, "status", lambda: {"open": True, "available": True})
    status, _payload = call(live["port"], "POST", "/api/window/open", live["token"],
                            {"url": "https://example.test/film.mp4"})
    assert status == 200
    assert seen["url"] == "https://example.test/film.mp4"
    assert seen["kwargs"].get("page", "player") == "player"


def test_window_open_rejects_an_unknown_page(live):
    status, payload = call(live["port"], "POST", "/api/window/open", live["token"],
                           {"page": "something-else"})
    assert status == 400
    assert b"page" in payload


def test_index_loads_with_a_valid_ticket_and_no_token(live):
    ticket = server.desktop_window.issue_ticket(live["token"])
    status, payload = call(live["port"], "GET", f"/index.html?desktop=1&ticket={ticket}")
    assert status == 200, "the visualiser window cannot load its own page"
    assert b"aura" in payload.lower()
    assert live["token"].encode() not in payload
    # The page's bootstrap still redeems it: one-time means one-time.
    status, payload = call(live["port"], "POST", "/api/window/bootstrap", None,
                           {"ticket": ticket})
    assert status == 200
    assert json.loads(payload.decode())["token"] == live["token"]
    status, _payload = call(live["port"], "POST", "/api/window/bootstrap", None,
                            {"ticket": ticket})
    assert status == 401


def test_index_without_token_or_ticket_is_still_refused(live):
    status, _payload = call(live["port"], "GET", "/index.html?desktop=1")
    assert status == 401
    status, _payload = call(live["port"], "GET", "/index.html?ticket=never-issued")
    assert status == 401


def test_window_status_reports_the_page_without_the_token(live, monkeypatch):
    monkeypatch.setattr(server.desktop_window, "status",
                        lambda: {"open": True, "available": True, "url": "",
                                 "pid": 1, "browser": "chromium", "page": "visualizer"})
    status, payload = call(live["port"], "GET", "/api/window", live["token"])
    body = json.loads(payload.decode())
    assert status == 200
    assert body["page"] == "visualizer"
    assert live["token"] not in payload.decode()
