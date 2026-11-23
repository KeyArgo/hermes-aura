"""The film in its own desktop window (a Chromium "app" window).

Hermes Desktop plugins cannot open OS windows, so the Aura server launches a
small Chrome/Chromium app window on ``web/player.html?desktop=1``. While it is
open the window is the player, and the server is the remote control: the page
polls ``/api/player/commands`` and reports its state to ``/api/player/report``,
so Hermes ("pause", "next episode") still drives it.

Adapted, trimmed, from REVamp's pop-out window
(``revamp_core/window.py``, same author, MIT). The Winamp/CDP resize parts are
deliberately not carried over: Aura's window is a normal sized video window and
the page does not resize it.

Everything here is best-effort and must never break a server request: a missing
browser raises :class:`WindowError` with a plain sentence, nothing else.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import config

BROWSERS = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
)
WINDOW_SIZE = (1024, 640)
LEASE = "desktop-window.json"
PROFILE_DIR = "desktop-browser"

_lock = threading.RLock()
# Window operations (check, close, launch, assign) run one at a time. Kept
# apart from _lock, which guards the tickets and the status read: a browser
# start takes seconds and must never stall a status request.
_op_lock = threading.RLock()
_proc: Optional[subprocess.Popen] = None
_closing: Optional[subprocess.Popen] = None  # closed by us; no handoff needed
_tickets: Dict[str, tuple[str, float]] = {}
TICKET_TTL = 30.0

def issue_ticket(token: str) -> str:
    with _lock:
        now = time.monotonic()
        for key, (_, expiry) in list(_tickets.items()):
            if expiry <= now:
                _tickets.pop(key, None)
        ticket = secrets.token_urlsafe(32)
        _tickets[ticket] = (token, now + TICKET_TTL)
        return ticket

def redeem_ticket(ticket: str) -> Optional[str]:
    with _lock:
        item = _tickets.pop(ticket, None)
    if not item or item[1] <= time.monotonic():
        return None
    return item[0]

def ticket_valid(ticket: str) -> bool:
    """Peek without consuming: the page itself is ticket-gated too, and the
    document load must not burn the one-time ticket the page's own bootstrap
    still needs to redeem for the token."""
    with _lock:
        item = _tickets.get(ticket)
    return bool(item and item[1] > time.monotonic())

_film_url = ""  # the video URL (never the player URL: that one carries the token)
_kind = ""  # "player" (the film) or "page" (a real site, e.g. a playlist to edit)
_screen = "player"  # what a "player"-kind window shows: "player" or "visualizer"


class WindowError(Exception):
    """No usable browser, or it would not start."""


def _on_windows() -> bool:
    """Windows-only paths (install folders, PowerShell, case-insensitive paths). One seam,
    so tests can exercise the Windows branch on any OS without faking os.name globally."""
    return os.name == "nt"


def _installed_browsers() -> List[str]:
    """Chromium-family browsers in their standard install folders, in preference order.

    Windows and macOS browsers are not on PATH, so a PATH-only search found none there
    and "Pop out to desktop" fell back to the small frame inside Hermes. Edge ships
    with every Windows install, so Windows always has one.
    """
    if _on_windows():
        roots = [os.environ.get(key, "") for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
        apps = (
            os.path.join("Google", "Chrome", "Application", "chrome.exe"),
            os.path.join("Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            os.path.join("Chromium", "Application", "chrome.exe"),
        )
        return [os.path.join(root, app) for app in apps for root in roots if root]
    if sys.platform == "darwin":
        bases = ("/Applications", os.path.expanduser("~/Applications"))
        apps = (
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Chromium.app/Contents/MacOS/Chromium",
        )
        return [os.path.join(base, app) for app in apps for base in bases]
    return []


def find_browser() -> Optional[str]:
    """``AURA_DESKTOP_BROWSER``, else the first Chromium-family browser on PATH, else
    one in its standard install folder (Windows, macOS)."""
    override = os.environ.get("AURA_DESKTOP_BROWSER")
    if override:
        return shutil.which(override) or (override if os.path.isfile(override) else None)
    for name in BROWSERS:
        path = shutil.which(name)
        if path:
            return path
    for path in _installed_browsers():
        if os.path.isfile(path):
            return path
    return None


def player_url(port: int, token: Optional[str], url: str, position: float = 0.0,
               video_id: str = "", paused: bool = False) -> str:
    """The exact page the window opens, with the same auth the player already uses."""
    query: Dict[str, str] = {"desktop": "1", "url": str(url or "")}
    if token:
        query["ticket"] = str(token)
    if paused:
        query["paused"] = "1"
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id or ""):
        query["video"] = video_id
    try:
        start = float(position or 0.0)
    except (TypeError, ValueError):
        start = 0.0
    if start > 0:
        query["t"] = str(int(start))
    return f"http://127.0.0.1:{int(port)}/player.html?{urllib.parse.urlencode(query)}"


def visualizer_url(port: int, token: Optional[str], reduced_motion: bool = False) -> str:
    """The visualiser page for the desktop window (Visualizer mode). Same
    one-time-ticket auth as the film window: the token never rides in a URL.
    No ``overlay=1`` here — a stand-alone window keeps the page's own status
    chrome so a failed bootstrap is visible, never a silent black rectangle."""
    query: Dict[str, str] = {"desktop": "1"}
    if token:
        query["ticket"] = str(token)
    if reduced_motion:
        query["reduced-motion"] = "1"
    return f"http://127.0.0.1:{int(port)}/index.html?{urllib.parse.urlencode(query)}"


def _feature_args() -> List[str]:
    """Chrome features to switch off (one switch: Chrome honours only the last).

    Windows: CalculateNativeWinOcclusion. Chrome stops painting a window it
    believes is covered; the window we raise from a background server was
    judged covered and stayed grey (title set, nothing drawn) until it was
    minimised and restored (owner, 11-15).
    """
    features = ["Translate"]
    if _on_windows():
        features.append("CalculateNativeWinOcclusion")
    return ["--disable-features=" + ",".join(features)]


def _gpu_args() -> List[str]:
    """Native Wayland for the private profile when the session is Wayland.

    Chrome's Linux default is still X11 Ozone; on NVIDIA/Wayland its private
    profile can fall back to SwiftShader. Only the platform switch is used —
    never an ANGLE backend or a driver-blocklist override.
    """
    if (sys.platform.startswith("linux")
            and os.environ.get("AURA_DESKTOP_GPU") != "0"
            and (os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
                 or os.environ.get("WAYLAND_DISPLAY"))):
        return ["--ozone-platform=wayland"]
    return []


def is_open() -> bool:
    with _lock:
        return _proc is not None and _proc.poll() is None


def _profile() -> Path:
    try:
        base = config.aura_dir()
    except Exception:  # noqa: BLE001 - a broken home must still not raise
        base = Path.home() / ".hermes" / "aura"
    return base / PROFILE_DIR


def _lease_path() -> Path:
    return _profile().parent / LEASE


def _write_lease(pid: int, url: str) -> None:
    try:
        _lease_path().write_text(json.dumps({
            "pid": int(pid),
            "ts": time.time(),
            "url": str(url or ""),
            "profile": str(_profile()),
        }), encoding="utf-8")
    except OSError:
        pass


def _clear_lease() -> None:
    try:
        _lease_path().unlink()
    except OSError:
        pass


def _command_line(pid: int) -> str:
    """The command line of ``pid``, or "" when it cannot be read.

    Linux exposes argv NUL-separated in /proc; macOS answers through ps; Windows has
    neither, so it is asked through PowerShell's Win32_Process.
    """
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().decode("utf-8", "replace")
    except OSError:
        pass
    if _on_windows():
        script = f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"
        args, timeout = ["powershell", "-NoProfile", "-NonInteractive", "-Command", script], 10
    else:
        args, timeout = ["ps", "-p", str(pid), "-o", "command="], 1
    try:
        result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _alive(pid: int) -> bool:
    """True while ``pid`` still runs.

    ``os.kill(pid, 0)`` is the cheap probe, but on Windows os.kill *terminates*
    the process, so Windows reads the command line it already knows how to fetch.
    """
    if pid <= 0:
        return False
    if _on_windows():
        return bool(_command_line(pid))
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _lease_pid() -> int:
    """The pid the lease records, 0 when there is no readable lease."""
    try:
        return int(json.loads(_lease_path().read_text(encoding="utf-8"))["pid"])
    except (OSError, ValueError, KeyError, TypeError):
        return 0


def _singleton_pid() -> int:
    """The pid Chromium's profile lock names (``SingletonLock`` → ``host-pid``).

    A window holds this link beside the profile for as long as it runs, so it
    finds an owner even when the lease was never written (or was cleared).
    Windows keeps no such link; the lease pid covers it there.
    """
    if _on_windows():
        return 0
    try:
        target = os.readlink(_profile() / "SingletonLock")
    except OSError:
        return 0
    try:
        return int(str(target).rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def _runs_on_profile(pid: int) -> bool:
    """True when ``pid`` is alive and started on this home's own window profile.

    PIDs get reused, so a lease or a lock alone is not proof: the command line
    must carry our ``--user-data-dir``. Windows quotes an argument with spaces
    ("--user-data-dir=C:\\...") and its paths are case-insensitive.
    """
    cmd = _command_line(pid)
    if not cmd:
        return False
    profile = str(_profile())
    profiles = {profile, os.path.realpath(profile)}
    flags = re.IGNORECASE if _on_windows() else 0
    return any(re.search(r'(?:^|[\0\s"])--user-data-dir="?' + re.escape(candidate) +
                         r'"?([\0\s"]|$)', cmd, flags) for candidate in profiles)


def _release_orphan() -> bool:
    """Free the profile from a window a previous server left holding it.

    The window survives an Aura restart (it runs in its own session), so a new
    launch only forwards to it and exits: the user sees 503 "exited
    immediately" although nothing is wrong with the browser. Terminate it —
    only ever a process whose command line carries OUR profile, since a reused
    pid would otherwise close an unrelated window — and let the caller retry.
    """
    pids: List[int] = []
    for pid in (_lease_pid(), _singleton_pid()):
        if pid and pid not in pids:
            pids.append(pid)
    released = False
    for pid in pids:
        if not _runs_on_profile(pid):
            continue
        try:
            os.killpg(pid, signal.SIGTERM)  # started with start_new_session: own group
        except (OSError, AttributeError):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                continue
        deadline = time.monotonic() + 5
        # The pid can be reused the moment the window exits, and _alive alone
        # cannot tell a dying window from the stranger that took its number.
        while time.monotonic() < deadline and _alive(pid) and _runs_on_profile(pid):
            time.sleep(0.1)
        if _alive(pid) and _runs_on_profile(pid):
            try:
                os.killpg(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
            except (OSError, AttributeError):
                try:
                    os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
                except OSError:
                    pass
            # A killed window still holds the profile for a moment; relaunching
            # into it at once would only hand off and exit again.
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and _alive(pid):
                time.sleep(0.1)
        released = True
    if released:
        _clear_lease()
    return released


def _launch(build_args: Callable[[], List[str]], browser: str) -> subprocess.Popen:
    """Start the browser and prove it stayed up: a window, not a hand-off.

    A browser that finds this profile already in use forwards to that instance
    and exits at once. Ours may be a window a previous server left behind (it
    survives the restart in its own session), so free the profile once and
    launch again before calling it a failure. Each launch builds its own
    arguments: the forwarded address may already have spent its one-time ticket.
    """
    attempt = 0
    while True:
        attempt += 1
        args = build_args()
        try:
            proc = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
        except OSError as exc:
            raise WindowError(f"could not start {browser}: {exc}") from exc
        try:
            proc.wait(1.5)
        except subprocess.TimeoutExpired:
            return proc
        if attempt == 1 and _release_orphan():
            continue
        raise WindowError(
            f"{os.path.basename(browser)} exited immediately "
            "(is another Aura window already open?)"
        )


def reap_orphan() -> bool:
    """At server start: close a window left behind by a previous server.

    Its token died with the old process, so it would only sit there showing an
    unauthorised page — and, worse, would still be playing audio.
    """
    pid = _lease_pid()
    if not pid:
        return False
    if not _command_line(pid):
        # The window is already gone, so the lease is dead too. Leaving it made
        # every start run the probe again (PowerShell on Windows) for nothing.
        _clear_lease()
        return False
    if not _runs_on_profile(pid):
        return False
    try:
        os.killpg(pid, signal.SIGTERM)  # started with start_new_session: own group
    except (OSError, AttributeError):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
    _clear_lease()
    return True


def _watch(proc: subprocess.Popen) -> None:
    proc.wait()
    global _proc, _film_url, _kind, _screen
    with _lock:
        current = _proc is proc
    if current:
        with _lock:
            _proc = None
            _film_url = ""
            _kind = ""
            _screen = "player"
        _clear_lease()


# -- bring to front --------------------------------------------------------------
# A window opened by a background server does not get focus by itself; it opens
# (or stays) behind Hermes. Best-effort per OS, never raises.

def _raise_windows(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    # Window handles are pointer-sized: without these declarations ctypes treats them
    # as a C int, which truncates (or refuses) a handle above 32 bits on 64-bit Windows.
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetForegroundWindow.argtypes = []
    for name in ("IsIconic", "BringWindowToTop", "SetForegroundWindow", "IsWindowVisible",
                 "GetWindowTextLengthW"):
        getattr(user32, name).argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    found: List[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _lparam):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd) > 0:
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(visit, 0)
    if not found:
        return False
    hwnd = found[0]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    # Windows refuses SetForegroundWindow from a background process unless its
    # input is attached to the thread that owns the foreground window.
    me = kernel32.GetCurrentThreadId()
    front = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    attached = bool(front and front != me and user32.AttachThreadInput(me, front, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, front, False)
    if user32.GetForegroundWindow() != hwnd:
        # Still refused: at least put it above the other windows.
        flags = 0x0001 | 0x0002 | 0x0040  # NOSIZE | NOMOVE | SHOWWINDOW
        user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)  # HWND_TOPMOST
        user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, flags)  # HWND_NOTOPMOST
    return True


def _raise_native(pid: int) -> bool:
    try:
        if _on_windows():
            return _raise_windows(pid)
        if sys.platform == "darwin":
            script = f'tell application "System Events" to set frontmost of (first process whose unix id is {int(pid)}) to true'
            args = ["osascript", "-e", script]
        elif shutil.which("xdotool"):
            args = ["xdotool", "search", "--onlyvisible", "--pid", str(int(pid)), "windowactivate"]
        else:
            return False  # Wayland and bare X: the compositor decides
        return subprocess.run(args, capture_output=True, check=False, timeout=3).returncode == 0
    except Exception:  # noqa: BLE001 - raising a window is cosmetic
        return False


def raise_window() -> bool:
    """Bring the open window to the front. False when there is none."""
    with _lock:
        pid = _proc.pid if (_proc is not None and _proc.poll() is None) else None
    return _raise_native(pid) if pid is not None else False


def _raise_when_shown(proc: subprocess.Popen) -> None:
    """A new window takes a moment to appear; keep trying briefly."""
    for _ in range(20):
        time.sleep(0.25)
        with _lock:
            if _proc is not proc:
                return
        if _raise_native(proc.pid):
            return


def open_page(url: str, title: str = "") -> Dict[str, Any]:
    """Open a real web page in the private profile — not the player page.

    Why this exists: the pop-out is ordinary Chromium with its own persistent
    profile, so a site behaves like a site there. That is how a playlist can be
    curated for real (add/remove) without any API scope: YouTube's own UI, the
    user's own session.
    """
    global _proc, _film_url, _kind
    target = str(url or "").strip()
    if not (target.startswith("https://") or target.startswith("http://")):
        raise WindowError("only http(s) pages can be opened")
    with _op_lock:
        with _lock:
            if _proc is not None and _proc.poll() is None:
                already = {"open": True, "already": True, "url": _film_url or target}
                pid = _proc.pid
            else:
                already = None
        if already:
            _raise_native(pid)
            return already
        browser = find_browser()
        if not browser:
            raise WindowError(
                "no Chrome or Chromium found; install one or set "
                "AURA_DESKTOP_BROWSER to its path"
            )
        profile = _profile()
        try:
            profile.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise WindowError(f"could not create the window profile: {exc}") from exc
        args: List[str] = [
            browser, f"--app={target}", f"--user-data-dir={profile}",
            f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
            "--no-first-run", "--no-default-browser-check",
        ]
        if sys.platform.startswith("linux"):
            args.append("--class=Aura")
        args.extend(_feature_args())
        args.extend(_gpu_args())
        try:
            proc = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
        except OSError as exc:
            raise WindowError(f"could not start the browser: {exc}") from exc
        with _lock:
            _proc = proc
            _film_url = target
            _kind = "page"
        # A browser forwarding to an instance already using this profile exits
        # at once; report that instead of pretending a window opened.
        try:
            proc.wait(1.5)
            with _lock:
                if _proc is proc:
                    _proc = None
                    _film_url = ""
                    _kind = ""
            _clear_lease()
            raise WindowError(
                f"{os.path.basename(browser)} exited immediately "
                "(is another Aura window already open?)"
            )
        except subprocess.TimeoutExpired:
            pass
        _write_lease(proc.pid, target)
        threading.Thread(target=_watch, args=(proc,), name="aura-window", daemon=True).start()
        threading.Thread(target=_raise_when_shown, args=(proc,), name="aura-window-raise", daemon=True).start()
        return {"open": True, "already": False, "url": target}


def open_window(port: int, token: Optional[str], url: str,
                position: float = 0.0, label: str = "", video_id: str = "",
                paused: bool = False, page: str = "player",
                reduced_motion: bool = False) -> Dict[str, Any]:
    """Open the window (or report the one already open). Raises WindowError.

    ``page`` picks what the window shows: "player" (the film, Video mode) or
    "visualizer" (the visualiser page, Visualizer mode — no film needed). A
    mode change while the window is open closes and reopens it on the new
    page: the window is a plain Chromium app window with a fixed address.
    """
    global _proc, _film_url, _kind, _screen
    if page not in ("player", "visualizer"):
        raise ValueError("page must be 'player' or 'visualizer'")
    # One window operation at a time: two requests arriving together both saw
    # no window, launched on the same profile, and the second hand-off exited —
    # freeing the profile by killing the window the first one had just opened.
    with _op_lock:
        with _lock:
            live = _proc is not None and _proc.poll() is None
            showing_page = live and _kind == "page"
            stale_screen = live and _kind == "player" and _screen != page
        if showing_page or stale_screen:
            # A playlist page is up (☰), or the mode changed under the window:
            # the new picture takes the window back (close + reopen cleanly).
            close_window()
        with _lock:
            if _proc is not None and _proc.poll() is None:
                already = {"open": True, "already": True, "url": _film_url or str(url or "")}
                pid = _proc.pid
            else:
                already = None
        if already:
            _raise_native(pid)
            return already
        browser = find_browser()
        if not browser:
            raise WindowError(
                "no Chrome or Chromium found; install one or set "
                "AURA_DESKTOP_BROWSER to its path"
            )
        profile = _profile()
        try:
            profile.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise WindowError(f"could not create the window profile: {exc}") from exc

        def build_args() -> List[str]:
            ticket = issue_ticket(token) if token else ""
            target = (visualizer_url(port, ticket, reduced_motion) if page == "visualizer"
                      else player_url(port, ticket, url, position, video_id, paused))
            args: List[str] = [
                browser, f"--app={target}", f"--user-data-dir={profile}",
                f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
                "--no-first-run", "--no-default-browser-check",
                "--autoplay-policy=no-user-gesture-required",
            ]
            if sys.platform.startswith("linux"):
                args.append("--class=Aura")
            args.extend(_feature_args())
            args.extend(_gpu_args())
            return args

        proc = _launch(build_args, browser)
        with _lock:
            _proc = proc
            _film_url = str(url or "") if page == "player" else ""
            _kind = "player"
            _screen = page
            # The lease is written with the pid it names: a concurrent close
            # must never find a window on record without its lease.
            _write_lease(proc.pid, _film_url)
    threading.Thread(target=_watch, args=(proc,), name="aura-window", daemon=True).start()
    threading.Thread(target=_raise_when_shown, args=(proc,), name="aura-window-raise", daemon=True).start()
    return {"open": True, "already": False, "url": str(url or ""),
            "pid": proc.pid, "label": str(label or "")}


def close_window() -> bool:
    """Close the window we opened. False when there was none."""
    # Same one-at-a-time rule as opening: a close landing mid-launch used to
    # see no window and report False while the launch went on to open one.
    with _op_lock:
        global _closing
        with _lock:
            proc = _proc
            if proc is None or proc.poll() is not None:
                return False
            _closing = proc
        try:
            proc.terminate()  # it may have exited on its own just now
            proc.wait(5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
        except OSError:
            pass
        _clear_lease()
        return True


def status() -> Dict[str, Any]:
    """What the plugin and the agent need to know; never the token."""
    with _lock:
        pid = _proc.pid if (_proc is not None and _proc.poll() is None) else None
        url = _film_url
        page = _screen if pid is not None and _kind == "player" else ""
    browser = find_browser()
    return {
        "open": pid is not None,
        "available": browser is not None,
        "url": url,
        "page": page,
        "pid": pid,
        "browser": os.path.basename(browser) if browser else "",
    }
