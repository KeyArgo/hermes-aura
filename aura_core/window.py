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
from typing import Any, Dict, List, Optional

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

_film_url = ""  # the video URL (never the player URL: that one carries the token)
_kind = ""  # "player" (the film) or "page" (a real site, e.g. a playlist to edit)


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


def reap_orphan() -> bool:
    """At server start: close a window left behind by a previous server.

    Its token died with the old process, so it would only sit there showing an
    unauthorised page — and, worse, would still be playing audio.
    """
    try:
        lease = json.loads(_lease_path().read_text(encoding="utf-8"))
        pid = int(lease["pid"])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    profile = str(_profile())
    cmd = _command_line(pid)
    if not cmd:
        return False
    # Ours only if it runs on this home's own browser profile (PIDs get reused).
    # Windows quotes an argument with spaces ("--user-data-dir=C:\...") and its
    # paths are case-insensitive.
    profiles = {profile, os.path.realpath(profile)}
    flags = re.IGNORECASE if _on_windows() else 0
    if not any(re.search(r'(?:^|[\0\s"])--user-data-dir="?' + re.escape(candidate) +
                         r'"?(?=[\0\s"]|$)', cmd, flags) for candidate in profiles):
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
    global _proc, _film_url, _kind
    with _lock:
        current = _proc is proc
    if current:
        with _lock:
            _proc = None
            _film_url = ""
            _kind = ""
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
    with _lock:
        if _proc is not None and _proc.poll() is None:
            already = {"open": True, "already": True, "url": _film_url or target}
            pid = _proc.pid
        else:
            already = None
    if already:
        _raise_native(pid)
        return already
    with _lock:
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
            "--disable-features=Translate",
        ]
        if sys.platform.startswith("linux"):
            args.append("--class=Aura")
        args.extend(_gpu_args())
        try:
            proc = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
        except OSError as exc:
            raise WindowError(f"could not start the browser: {exc}") from exc
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
                paused: bool = False) -> Dict[str, Any]:
    """Open the window (or report the one already open). Raises WindowError."""
    global _proc, _film_url, _kind
    with _lock:
        live = _proc is not None and _proc.poll() is None
        showing_page = live and _kind == "page"
    if showing_page:
        close_window()  # a playlist page is up (☰): the film takes the window back
    with _lock:
        if _proc is not None and _proc.poll() is None:
            already = {"open": True, "already": True, "url": _film_url or str(url or "")}
            pid = _proc.pid
        else:
            already = None
    if already:
        _raise_native(pid)
        return already
    with _lock:
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
        ticket = issue_ticket(token) if token else ""
        target = player_url(port, ticket, url, position, video_id, paused)
        args: List[str] = [
            browser, f"--app={target}", f"--user-data-dir={profile}",
            f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
            "--no-first-run", "--no-default-browser-check",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-features=Translate",
        ]
        if sys.platform.startswith("linux"):
            args.append("--class=Aura")
        args.extend(_gpu_args())
        try:
            proc = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
        except OSError as exc:
            raise WindowError(f"could not start {browser}: {exc}") from exc
        _proc = proc
        _film_url = str(url or "")
        _kind = "player"
    # A browser forwarding to an instance already using this profile exits at once.
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
    _write_lease(proc.pid, str(url or ""))
    threading.Thread(target=_watch, args=(proc,), name="aura-window", daemon=True).start()
    threading.Thread(target=_raise_when_shown, args=(proc,), name="aura-window-raise", daemon=True).start()
    return {"open": True, "already": False, "url": str(url or ""),
            "pid": proc.pid, "label": str(label or "")}


def close_window() -> bool:
    """Close the window we opened. False when there was none."""
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
    browser = find_browser()
    return {
        "open": pid is not None,
        "available": browser is not None,
        "url": url,
        "pid": pid,
        "browser": os.path.basename(browser) if browser else "",
    }
