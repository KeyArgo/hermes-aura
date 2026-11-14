"""The pop-out window: browser discovery, launch args, lease/reap, status.

No browser is ever launched: ``subprocess.Popen``, ``shutil.which`` and the
lease file are all faked. The one real thing is the command line we build —
that is what makes the window load Aura's player with its token.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from aura_core import config
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
    """Never starts: the watcher would wait on a fake process forever."""

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def start(self):
        pass


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(window, "_proc", None)
    monkeypatch.setattr(window, "_closing", None)
    monkeypatch.setattr(window, "_film_url", "")
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
    return calls


def test_find_browser_uses_the_override(monkeypatch):
    monkeypatch.setenv("AURA_DESKTOP_BROWSER", "/opt/chrome")
    monkeypatch.setattr(window.shutil, "which", lambda name: None)
    monkeypatch.setattr(window.os.path, "isfile", lambda path: path == "/opt/chrome")
    assert window.find_browser() == "/opt/chrome"


def test_find_browser_scans_the_known_family(monkeypatch):
    monkeypatch.delenv("AURA_DESKTOP_BROWSER", raising=False)
    monkeypatch.setattr(window.shutil, "which",
                        lambda name: "/usr/bin/brave-browser" if name == "brave-browser" else None)
    assert window.find_browser() == "/usr/bin/brave-browser"


def test_no_browser_raises_a_clear_error(popen, monkeypatch):
    monkeypatch.setattr(window, "find_browser", lambda: None)
    with pytest.raises(window.WindowError, match="AURA_DESKTOP_BROWSER"):
        window.open_window(4567, "tok", "https://example.test/film.mp4")


def test_player_url_carries_desktop_auth_and_position():
    url = window.player_url(4567, "s3cret", "https://youtu.be/abc", 61.9)
    assert url.startswith("http://127.0.0.1:4567/player.html?")
    assert "desktop=1" in url
    assert "t=61" in url
    assert "url=https%3A%2F%2Fyoutu.be%2Fabc" in url
    assert "ticket=s3cret" in url


def test_open_window_builds_an_app_window_on_the_player(popen):
    result = window.open_window(4567, "tok", "https://example.test/film.mp4", 12.0)
    assert result["open"] is True and result["already"] is False
    assert result["pid"] == 4242
    args, kwargs, proc = popen[0]
    assert args[0] == "/usr/bin/chromium"
    app = next(a for a in args if a.startswith("--app="))
    assert app.startswith("--app=http://127.0.0.1:4567/player.html?")
    assert "desktop=1" in app and "t=12" in app
    profile = next(a for a in args if a.startswith("--user-data-dir="))
    assert profile.split("=", 1)[1].endswith("desktop-browser")
    assert "--autoplay-policy=no-user-gesture-required" in args
    assert kwargs["start_new_session"] is True
    assert proc.args is args


def test_open_window_records_a_lease_and_status(popen, tmp_path):
    window.open_window(4567, "tok", "https://example.test/film.mp4", 3.0)
    lease = json.loads((tmp_path / "aura" / window.LEASE).read_text())
    assert lease["pid"] == 4242
    status = window.status()
    assert status["open"] is True
    assert status["url"] == "https://example.test/film.mp4"
    assert "tok" not in json.dumps(status)


def test_open_window_twice_reports_already(popen):
    first = window.open_window(4567, "tok", "https://example.test/a.mp4")
    second = window.open_window(4567, "tok", "https://example.test/b.mp4")
    assert first["already"] is False
    assert second == {"open": True, "already": True,
                      "url": "https://example.test/a.mp4"}
    assert len(popen) == 1


def test_open_window_that_exits_at_once_is_an_error(popen, monkeypatch):
    def dying(args, **kwargs):
        proc = FakeProc(exit_immediately=True)
        proc.args = args
        popen.append((args, kwargs, proc))
        return proc

    monkeypatch.setattr(window.subprocess, "Popen", dying)
    with pytest.raises(window.WindowError, match="exited immediately"):
        window.open_window(4567, "tok", "https://example.test/film.mp4")
    assert window.status()["open"] is False


def test_close_window_terminates_and_clears(popen):
    window.open_window(4567, "tok", "https://example.test/film.mp4")
    proc = popen[0][2]
    assert window.close_window() is True
    assert proc.terminated == 1
    assert window.status()["open"] is False
    assert window.close_window() is False


def test_status_without_a_window_is_honest(monkeypatch):
    monkeypatch.setattr(window, "find_browser", lambda: None)
    status = window.status()
    assert status["open"] is False
    assert status["available"] is False


def _write_lease(tmp_path, pid, profile):
    path = tmp_path / "aura" / window.LEASE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pid": pid, "ts": 0, "profile": profile}))
    return path


def test_reap_ignores_a_lease_without_ours_missing(tmp_path):
    assert window.reap_orphan() is False


def test_reap_ignores_a_pid_that_is_not_ours(tmp_path, monkeypatch):
    # A live PID whose command line has no --user-data-dir for our profile:
    # a reused PID must never be signalled.
    import os

    profile = str(window._profile())
    _write_lease(tmp_path, os.getpid(), profile)
    assert window.reap_orphan() is False


def test_reap_kills_only_our_profile(tmp_path, monkeypatch):
    import io
    import os

    profile = str(window._profile())
    _write_lease(tmp_path, 987654, profile)
    argv = f"/usr/bin/chromium\0--app=x\0--user-data-dir={profile}\0".encode()
    real_open = open

    def fake_open(path, *args, **kwargs):
        if path == "/proc/987654/cmdline":
            return io.BytesIO(argv)
        return real_open(path, *args, **kwargs)

    killed = []
    monkeypatch.setattr("builtins.open", fake_open)
    # raising=False: os.killpg does not exist on Windows; the reap logic is driven by
    # the faked /proc data either way.
    monkeypatch.setattr(window.os, "killpg", lambda pid, sig: killed.append(pid), raising=False)
    assert window.reap_orphan() is True
    assert killed == [987654]
    assert not (tmp_path / "aura" / window.LEASE).exists()
    assert os.getpid() != 987654


def test_find_browser_finds_edge_in_its_windows_install_folder(tmp_path, monkeypatch):
    """Windows browsers are not on PATH, so a PATH-only search found none: "Pop out to
    desktop" was never available and fell back to the small frame inside Hermes."""
    edge = tmp_path / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    edge.parent.mkdir(parents=True)
    edge.write_bytes(b"")
    monkeypatch.delenv("AURA_DESKTOP_BROWSER", raising=False)
    monkeypatch.setattr(window.shutil, "which", lambda name: None)
    monkeypatch.setattr(window, "_on_windows", lambda: True)
    monkeypatch.setenv("PROGRAMFILES", str(tmp_path / "nothing-here"))
    monkeypatch.setenv("PROGRAMFILES(X86)", str(tmp_path))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "nothing-here-either"))

    assert window.find_browser() == str(edge), "Edge in its install folder was not found"


def test_reap_finds_and_closes_a_leftover_window_on_windows(tmp_path, monkeypatch):
    """Windows has neither /proc nor ps: the reaper asks Windows for the command line,
    and Windows quotes arguments with spaces ("--user-data-dir=C:\\...")."""
    import builtins
    import subprocess

    profile = str(window._profile())
    _write_lease(tmp_path, 987654, profile)
    real_open = builtins.open

    def no_proc(path, *args, **kwargs):
        if str(path).startswith("/proc/"):
            raise OSError("no /proc on Windows")
        return real_open(path, *args, **kwargs)

    asked = []

    def fake_run(args, **kwargs):
        asked.append(args)
        cmd = f'"C:\\Program Files\\Chromium\\chrome.exe" --app=x "--user-data-dir={profile}"'
        return subprocess.CompletedProcess(args, 0, stdout=cmd + "\r\n", stderr="")

    killed = []
    monkeypatch.setattr("builtins.open", no_proc)
    monkeypatch.setattr(window, "_on_windows", lambda: True)
    monkeypatch.setattr(window.subprocess, "run", fake_run)
    monkeypatch.setattr(window.os, "killpg", lambda pid, sig: killed.append(pid), raising=False)
    monkeypatch.setattr(window.os, "kill", lambda pid, sig: killed.append(pid))

    assert window.reap_orphan() is True, "a leftover window on Windows was not recognised"
    assert killed == [987654]
    assert asked and asked[0][0].lower().startswith("powershell"), f"asked {asked}, not Windows"
    assert not (tmp_path / "aura" / window.LEASE).exists()


def test_player_url_preserves_playlist_episode():
    url = window.player_url(4567, 'token', 'https://youtube.com/playlist?list=abc', 42,
                            video_id='abcdefghijk')
    assert 'video=abcdefghijk' in url
    assert 't=42' in url


def test_browser_arguments_never_contain_server_token(popen):
    window.open_window(4567, 'very-secret-token', 'https://example.test/film.mp4')
    args = popen[0][0]
    assert 'very-secret-token' not in ' '.join(args)
    assert 'ticket=' in ' '.join(args)


def test_window_preserves_paused_state(popen):
    window.open_window(4567, 'token', 'https://example.test/film.mp4', paused=True)
    app = next(arg for arg in popen[0][0] if arg.startswith('--app='))
    assert 'paused=1' in app


def test_open_page_loads_the_raw_page_not_the_player(popen):
    """Manage opens YouTube's own page in the window, not Aura's player.

    The window is ordinary Chromium on Aura's own profile, which is the only
    reason a playlist can be edited for real: the site is the site there.
    """
    url = "https://www.youtube.com/playlist?list=PL0123456789"
    window.open_page(url)
    app = next(arg for arg in popen[0][0] if arg.startswith("--app="))
    assert app == "--app=" + url
    assert "player.html" not in app
    assert "ticket=" not in app


def test_open_page_refuses_anything_but_http(popen):
    for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "", "   "]:
        with pytest.raises(window.WindowError):
            window.open_page(bad)
    assert popen == [], "a rejected url still launched a browser"


def test_open_page_reuses_a_live_window(popen):
    first = window.open_page("https://example.test/one")
    second = window.open_page("https://example.test/two")
    assert first["already"] is False
    assert second["already"] is True, "a second page was launched over a live window"
    assert len(popen) == 1
    assert second["url"] == "https://example.test/one"


def test_open_page_that_exits_at_once_is_an_error(popen, monkeypatch):
    def dying(args, **kwargs):
        proc = FakeProc(exit_immediately=True)
        proc.args = args
        return proc

    monkeypatch.setattr(window.subprocess, "Popen", dying)
    with pytest.raises(window.WindowError):
        window.open_page("https://example.test/one")
