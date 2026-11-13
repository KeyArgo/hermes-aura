"""Aura local server: loopback HTTP + RFC6455 WebSocket, PCM/feature push.

Wire contract: CONTRACT.md §1, §2, §3, §6, §7. Stdlib only.

Design notes that matter:

* Bind ``127.0.0.1:0`` (ephemeral). The port is never fixed and never leased.
* A ``Host`` header that is not ``127.0.0.1:<port>`` / ``localhost:<port>`` is
  rejected (DNS-rebinding guard).
* The bearer token lives in ``<HERMES_HOME>/aura/token`` (0600), regenerated on
  every start. It is never logged: every log line goes through ``redact``.
* Each WebSocket client has bounded queues; when a client falls behind, old
  frames are dropped instead of queued (§2 "Drop, never queue").
* Capture runs in a daemon thread. No device means ``capture == "none"`` and
  all-zero silent features — never an exception (§6).
* Every module-level entry point (``ensure_server``, ``get_port``,
  ``publish_mood``, ``publish_config``, ``stop_server``) swallows and logs
  exceptions, because L4 calls them from agent hooks (§7).
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

try:  # POSIX leader election; Windows keeps today's single-process behaviour.
    import fcntl
except ImportError:  # pragma: no cover - exercised only on Windows
    fcntl = None  # type: ignore[assignment]

from . import analysis, behavior, config, quality, radio, redact
from . import window as desktop_window
from .capture import base as capture

logger = logging.getLogger("aura.server")

VERSION = "1.0.0"  # mirrors plugin.yaml; tools/release_check.py enforces it
SAMPLE_RATE = 48000
FRAME_SAMPLES = 1024
FEATURE_INTERVAL_S = 0.1  # ≤10 Hz (§2)
CAPTURE_RETRY_S = 10.0  # while on silence, look for a real backend this often
IDLE_STOP_S = 30.0  # no listeners this long -> stop capture
CAPTURE_GATE_S = 0.5  # how often the capture loop re-reads enabled/motion
# Motion values whose visuals are driven by real audio. Anything else (designs,
# agent) means no recorder may stay open.
AUDIO_MOTIONS = ("both", "music", "agent_music")
MOOD_KEEPALIVE_S = 2.0
MAX_CONTROL_BYTES = 64 * 1024
MAX_WS_QUEUE_PCM = 4      # ~85 ms of audio; older frames are dropped
MAX_WS_QUEUE_EVENT = 64

MOODS = ("idle", "thinking", "tool", "approval", "error", "streaming", "done")

# [listen lane] What the agent may ask the desktop's audio channel to do. The
# four video/audio transport actions travel in the same audio_request frame so
# there is one delivery path for "play this" and "mute the film".
AUDIO_ACTIONS = ("play", "stop", "volume", "mute_video", "unmute_video")

PRESETS = [
    {"name": "aura-drift", "family": "spectral", "strobe": False},
    {"name": "aura-bloom", "family": "particles", "strobe": False},
    {"name": "aura-pulse", "family": "spectrum", "strobe": False},
    {"name": "aura-tunnel", "family": "geometric", "strobe": False},
    {"name": "aura-orbit", "family": "geometric", "strobe": False},
    {"name": "aura-nebula", "family": "particles", "strobe": False},
    {"name": "aura-waveform", "family": "spectrum", "strobe": False},
    {"name": "aura-fractal", "family": "fractal", "strobe": False},
    {"name": "aura-ripple", "family": "spectral", "strobe": False},
    {"name": "aura-strobe", "family": "spectrum", "strobe": True},
]
DEFAULT_PRESET = "aura-drift"

# ---------------------------------------------------------------------------
# static assets (the page the desktop half embeds)
# ---------------------------------------------------------------------------

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

#: Path -> Content-Type. Only these exact files, plus one level under /vendor/.
_STATIC_TYPES = {
    "/aura.js": "text/javascript; charset=utf-8",
    "/pcm-worklet.js": "text/javascript; charset=utf-8",
    "/presets.json": "application/json; charset=utf-8",
    "/player.html": "text/html; charset=utf-8",
    # [listen lane] The audio channel (radio / direct audio URLs) loaded by
    # both the visualiser page and the video backdrop page.
    "/audio.js": "text/javascript; charset=utf-8",
    # The CC rules (embed query + live player commands), loaded by the video
    # backdrop page and exercised by its contract test.
    "/captions.js": "text/javascript; charset=utf-8",
    # What a quality switch is: YouTube's one honest answer, and the swap rule
    # that keeps the position. Loaded by the same page.
    "/quality.js": "text/javascript; charset=utf-8",
}
_VENDOR_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}

# [security] The radio proxy relays a third party's bytes from Aura's own
# origin. The station's Content-Type is therefore attacker-controlled input:
# echoing it verbatim let a station answer ``text/html`` and run script in the
# Aura origin (which holds the bearer token). Only an exact audio type is
# allowed through, normalised and without parameters; everything else is
# served as opaque bytes, so a browser cannot render or execute it.
_AUDIO_TYPES = {
    "audio/mpeg": "audio/mpeg",
    "audio/mp3": "audio/mpeg",
    "audio/x-mp3": "audio/mpeg",
    "audio/aac": "audio/aac",
    "audio/aacp": "audio/aacp",
    "audio/x-aac": "audio/aac",
    "audio/ogg": "audio/ogg",
    "application/ogg": "audio/ogg",
    "audio/opus": "audio/opus",
    "audio/webm": "audio/webm",
    "audio/wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/flac": "audio/flac",
    "audio/x-flac": "audio/flac",
    "audio/mp4": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "application/octet-stream": "application/octet-stream",
}
#: What any non-audio (or unparsable) upstream type becomes.
STREAM_FALLBACK_TYPE = "application/octet-stream"
#: What a station that sends no Content-Type at all gets: ICY servers often
#: omit it, and audio/mpeg is both the historical answer and not executable.
STREAM_DEFAULT_TYPE = "audio/mpeg"
#: Second line of defence: even a browser that renders the body as a document
#: gets an opaque origin with no script, no loads and no framing.
STREAM_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'"


def _proxy_content_type(raw: Any) -> str:
    """Map an upstream stream ``Content-Type`` to a type Aura may serve.

    Exact-match whitelist (case-insensitive, parameters dropped); anything
    else — ``text/html``, ``image/svg+xml``, ``application/javascript``, junk,
    a non-string — is downgraded to ``application/octet-stream``. A missing or
    empty header keeps the historical ``audio/mpeg`` default.
    """
    if raw is None:
        return STREAM_DEFAULT_TYPE
    if not isinstance(raw, str):
        return STREAM_FALLBACK_TYPE
    base = raw.split(";", 1)[0].strip().lower()
    if not base:
        return STREAM_DEFAULT_TYPE
    return _AUDIO_TYPES.get(base, STREAM_FALLBACK_TYPE)


_PRESETS_CACHE: dict | None = None


def _presets_payload() -> dict:
    """Preset catalogue from web/presets.json — the page loads the same file.

    The built-in PRESETS list is only a fallback: the page resolves preset names
    against its own butterchurn bundle, so a name that is not in presets.json
    would silently fail to load.
    """
    global _PRESETS_CACHE
    if _PRESETS_CACHE is None:
        payload: dict | None = None
        try:
            data = json.loads((WEB_DIR / "presets.json").read_text(encoding="utf-8"))
            entries = [
                {"name": p["name"], "family": p.get("family", "unknown"), "strobe": bool(p.get("strobe", False))}
                for p in data.get("presets", [])
                if isinstance(p, dict) and isinstance(p.get("name"), str) and p["name"]
            ]
            if entries:
                default = data.get("default")
                payload = {
                    "presets": entries,
                    "default": default if default in {e["name"] for e in entries} else entries[0]["name"],
                }
        except (OSError, ValueError, TypeError):
            payload = None
        _PRESETS_CACHE = payload or {"presets": PRESETS, "default": DEFAULT_PRESET}
    return _PRESETS_CACHE


_CATALOG_CACHE: dict | None = None


def _catalog_payload() -> dict:
    """The Aura shelf's catalogue, from ``web/catalog.json`` — read once, cached.

    The file is generated by ``tools/build_catalog.py`` and committed, so the
    server reads what the repository ships instead of calling archive.org for
    every page load. (The quality picker's ``/api/quality`` is the one place the
    server does ask archive.org, and it asks only for one item's file list,
    with a short timeout and a cache.) A malformed or missing file is reported
    as an empty catalogue instead of a 500, because the page must keep working
    with its built-in Picks alone.
    """
    global _CATALOG_CACHE
    if _CATALOG_CACHE is None:
        items: list[dict] = []
        try:
            data = json.loads((WEB_DIR / "catalog.json").read_text(encoding="utf-8"))
            for entry in data if isinstance(data, list) else []:
                if not isinstance(entry, dict):
                    continue
                category = entry.get("category")
                title = entry.get("title")
                url = entry.get("url")
                if not (isinstance(category, str) and isinstance(title, str) and isinstance(url, str)):
                    continue
                if not category or not title or not url.startswith(("https://", "http://")):
                    continue
                year = entry.get("year")
                duration = entry.get("duration_s")
                items.append({
                    "category": category,
                    "title": title,
                    "year": year if isinstance(year, int) and not isinstance(year, bool) else None,
                    "url": url,
                    "licence": entry.get("licence") if isinstance(entry.get("licence"), str) else "",
                    "note": entry.get("note") if isinstance(entry.get("note"), str) else "",
                    "duration_s": duration if isinstance(duration, int) and not isinstance(duration, bool) else None,
                })
        except (OSError, ValueError, TypeError):
            items = []
        _CATALOG_CACHE = {"ok": bool(items), "count": len(items), "items": items}
    return _CATALOG_CACHE


# ---------------------------------------------------------------------------
# shared state
# ---------------------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.httpd: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.port: int | None = None
        self.token: str | None = None
        self.capture_obj: Any = None
        self.capture_thread: threading.Thread | None = None
        self.capture_name = "none"
        self.stop_event = threading.Event()
        self.clients: set = set()
        self.features = analysis.silence_features()
        self.feature_seq = 0
        self.pcm_seq = 0
        self.mood = "idle"
        self.mood_intensity = 0.0
        self.mood_ttl_ms = 0
        self.mood_prev = "idle"
        self.mood_prev_intensity = 0.0
        self.mood_expiry: float | None = None
        self.mood_last_sent = 0.0
        self.preset = None
        self.capture_lost_reported = False
        # Dynamic intensity (§9.6): live active-chat count and its multiplier.
        self.session_count = 0
        self.session_boost = 1.0
        self.session_thread: threading.Thread | None = None
        # The film: whichever player is active reports here, and Hermes (the
        # agent tool) writes commands that the desktop window polls for.
        self.player: dict = {}
        self.player_seq = 0
        # The desktop's saved library (playlists + films) as it last reported
        # it. ``None`` until a desktop reports: "not reported yet" is not the
        # same answer as "your list is empty".
        self.library: list | None = None
        self.commands: list = []
        self.command_seq = 0
        # [listen lane] Audio channel requests for the desktop half:
        # {"url","label","seq","at"} plus an optional "action"/"value".
        # The desktop polls /api/state (through the dashboard) and applies
        # every request whose seq it has not seen yet, in order. Keeping a
        # list is what stops a play followed by a mute from losing the play.
        self.audio_requests: list = []
        self.audio_request: dict | None = None
        self.audio_seq = 0


_STATE = _State()

# ---------------------------------------------------------------------------
# single-server leader election (CONTRACT §7)
#
# One server per HERMES_HOME.  ``flock`` is associated with the open file
# description, so two module copies inside one process (the Hermes gateway
# loads the plugin both namespaced and plain) also exclude each other.
# ---------------------------------------------------------------------------

_LOCK_FD: int | None = None
# The resolved home this process registered/elected for. A gateway turn may run
# under a context-local override pointing at another profile; such a call must
# never start a second server here, it only forwards to that home's leader.
_LOCK_HOME: str | None = None
_TAKEOVER_AT = 0.0
_TAKEOVER_LOCK = threading.Lock()
_START_LOCK = threading.RLock()
# True once a non-blocking lock attempt found a live leader for this home.
_FOLLOWING = False

# Windows has no ``flock``. The counterpart with the same one-leader-per-home promise is a named
# kernel mutex: it lives exactly as long as one process holds it, every process finds it by name,
# and it dies with the process. Without it every process that merely loads the plugin (a CLI
# command, a doctor probe, an app rescan) started its own server and rewrote ``<home>/aura/token``,
# so the pane and the tools held a token the live server rejected: every control call answered 401
# while the already-loaded film kept playing.
_WIN_MUTEX: int | None = None
_MUTEX_ERROR_ALREADY_EXISTS = 183


def _home_key() -> str | None:
    """The current context's Hermes home as a resolved string."""
    try:
        return str(config.hermes_home().resolve())
    except Exception:  # noqa: BLE001
        return None


def _is_own_home() -> bool:
    """True when the current context resolves to the home this process serves."""
    if _LOCK_HOME is None:
        return True
    return _home_key() == _LOCK_HOME


def _log(msg: str, *args) -> None:
    """Log without ever leaking the token."""
    try:
        logger.info(redact.redact_text(msg % args if args else msg))
    except Exception:  # noqa: BLE001
        pass


def _win_mutex_name() -> str | None:
    """Per-home kernel object name: one leader per HERMES_HOME, no cross-home collisions."""
    try:
        home = str(config.hermes_home().resolve()).casefold()
    except Exception:  # noqa: BLE001
        return None
    digest = hashlib.sha256(home.encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return "Local\\hermes-aura-" + digest


def _try_acquire_win_mutex() -> bool:
    """Non-blocking Windows leader election; True when this process now owns the mutex.

    ``CreateMutexW`` returns a handle either way; ``ERROR_ALREADY_EXISTS`` means another process
    created it first, so this one is a follower and must not start a server or rewrite the
    token/lease advertisement.
    """
    global _WIN_MUTEX, _LOCK_HOME
    if _WIN_MUTEX is not None:
        return True
    if os.name != "nt":
        return False
    name = _win_mutex_name()
    if name is None:
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPCVOID, wintypes.BOOL, wintypes.LPCWSTR]
        handle = kernel32.CreateMutexW(None, True, name)
        if not handle:
            _log("aura: mutex create failed (errno %s)", ctypes.get_last_error())
            return False
        if ctypes.get_last_error() == _MUTEX_ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(wintypes.HANDLE(handle))
            return False
    except Exception as exc:  # noqa: BLE001 - election must never block register()
        _log("aura: mutex election failed (%s)", type(exc).__name__)
        return False
    _WIN_MUTEX = int(handle)
    _LOCK_HOME = _home_key()
    return True


def _release_win_mutex() -> None:
    """Drop the Windows leader mutex, if this process holds it."""
    global _WIN_MUTEX
    handle, _WIN_MUTEX = _WIN_MUTEX, None
    if handle is None or os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes

        ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(wintypes.HANDLE(handle))
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# websocket helpers
# ---------------------------------------------------------------------------

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_accept(key: str) -> str:
    digest = hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _ws_frame(opcode: int, payload: bytes) -> bytes:
    """Server→client frame: FIN set, unmasked (§2)."""
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    return bytes(header) + payload


def _ws_close_frame(code: int, reason: str = "") -> bytes:
    return _ws_frame(0x8, struct.pack(">H", code) + reason.encode("utf-8")[:120])


def _ws_pcm_frame(seq: int, ts_ms: int, samples: bytes, silence: bool) -> bytes:
    """Binary PCM frame exactly as CONTRACT.md §2 (32-byte header)."""
    n = len(samples) // 4
    flags = 1 if silence else 0
    header = struct.pack("<4sBBHQQII", b"AURA", 1, flags, 32, seq, ts_ms,
                         SAMPLE_RATE, n)
    return header + samples[: n * 4]


class _Client:
    """One connected page: bounded queues, drop-oldest under backpressure."""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.pcm = collections.deque(maxlen=MAX_WS_QUEUE_PCM)
        self.events = collections.deque(maxlen=MAX_WS_QUEUE_EVENT)
        self.cond = threading.Condition()
        self.closed = False
        self._send_lock = threading.Lock()
        self.dropped = 0

    def push_pcm(self, payload: bytes) -> None:
        with self.cond:
            if self.closed:
                return
            if len(self.pcm) == self.pcm.maxlen:
                self.dropped += 1
            self.pcm.append(payload)
            self.cond.notify()

    def push_event(self, obj: dict) -> None:
        try:
            payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            return
        with self.cond:
            if self.closed:
                return
            if len(self.events) == self.events.maxlen:
                self.dropped += 1
            self.events.append(payload)
            self.cond.notify()

    def pop(self, timeout: float):
        """Return ``(opcode, payload)`` or ``None`` on timeout."""
        with self.cond:
            if self.closed:
                return None
            if not self.pcm and not self.events:
                self.cond.wait(timeout)
            if self.closed:
                return None
            if self.pcm:
                return 0x2, self.pcm.popleft()
            if self.events:
                return 0x1, self.events.popleft()
            return None

    def send(self, opcode: int, payload: bytes) -> None:
        with self._send_lock:
            self.sock.sendall(_ws_frame(opcode, payload))

    def close(self) -> None:
        with self.cond:
            if self.closed:
                return
            self.closed = True
            self.cond.notify_all()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# broadcast / events
# ---------------------------------------------------------------------------

def _clients_snapshot() -> list:
    with _STATE.lock:
        return list(_STATE.clients)


def _broadcast_pcm(payload: bytes) -> None:
    for client in _clients_snapshot():
        client.push_pcm(payload)


def _broadcast_event(obj: dict) -> None:
    for client in _clients_snapshot():
        client.push_event(obj)


def _session_boost_snapshot() -> dict:
    with _STATE.lock:
        return {
            "sessions": _STATE.session_count,
            "session_boost": _STATE.session_boost,
        }


def _config_event() -> dict:
    cfg = config.load_config()
    return {
        "type": "config",
        "enabled": bool(cfg["enabled"]),
        "intensity": cfg["intensity"],
        **_session_boost_snapshot(),
        "reduced_motion": cfg["reduced_motion"],
        "capture": _STATE.capture_name,
        "theme_opt_in": cfg["theme_opt_in"],
        "opacity": cfg["opacity"],
        "behavior": cfg["behavior"],
        "mood_reactive": bool(cfg["mood_reactive"]),
        "accent_pulse": bool(cfg["accent_pulse"]),
        "auto_preset": bool(cfg["auto_preset"]),
        "motion": cfg["motion"],
        "idle_motion": cfg["idle_motion"],
        "behavior_profile": behavior.profile(cfg["behavior"]),
    }


def _mood_event(mood: str, intensity: float, ttl_ms: int) -> dict:
    with _STATE.lock:
        _STATE.feature_seq += 1
        seq = _STATE.feature_seq
    return {
        "type": "mood",
        "mood": mood,
        "intensity": max(0.0, min(1.0, float(intensity))),
        "ttl_ms": max(0, int(ttl_ms)),
        "seq": seq,
    }


def _mood_tick(now: float) -> None:
    """Expire a timed mood back to the previous one; keepalive non-idle moods."""
    with _STATE.lock:
        mood = _STATE.mood
        expiry = _STATE.mood_expiry
        intensity = _STATE.mood_intensity
        ttl = _STATE.mood_ttl_ms
        send = False
        if expiry is not None and now >= expiry:
            # Restore-on-clear, mirroring mood.py: only a transient activity mood
            # may be restored. Restoring an attention mood (approval/error) or
            # done bare would latch it forever.
            target = _STATE.mood_prev
            if target not in ("thinking", "tool", "streaming"):
                target = "idle"
            _STATE.mood = target
            _STATE.mood_intensity = _STATE.mood_prev_intensity if target != "idle" else 0.0
            _STATE.mood_prev = "idle" if target == "idle" else _STATE.mood_prev
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
            mood = _STATE.mood
            intensity = _STATE.mood_intensity
            ttl = 0
            send = True
        elif mood != "idle" and now - _STATE.mood_last_sent >= MOOD_KEEPALIVE_S:
            send = True
        else:
            send = False
    if send:
        _broadcast_event(_mood_event(mood, intensity, ttl))
        with _STATE.lock:
            _STATE.mood_last_sent = now


def _audio_wanted() -> bool:
    """Capture runs only while Aura is on and the motion source is audio."""
    cfg = config.load_config()
    return bool(cfg["enabled"]) and cfg["motion"] in AUDIO_MOTIONS


def _swap_capture(old, new):
    """Publish ``new`` as the live capture and close ``old`` (never leak a recorder)."""
    with _STATE.lock:
        _STATE.capture_obj = new
        _STATE.capture_name = new.name
    try:
        old.close()
    except Exception:  # noqa: BLE001
        pass
    return new


def _capture_loop(stop_event: threading.Event) -> None:
    analyser = analysis.Analyser()
    frame_silence = analysis.FrameSilence()
    cap = None
    preferred = None
    try:
        preferred = config.capture_override()
        if preferred and preferred not in ("pipewire", "pulse", "wasapi", "macos", "none"):
            preferred = None
        if _audio_wanted():
            cap = capture.open_capture(preferred)
            with _STATE.lock:
                _STATE.capture_obj = cap
                _STATE.capture_name = cap.name
            _log("aura: capture backend %s", cap.name)
        else:
            cap = capture.NullCapture()
            with _STATE.lock:
                _STATE.capture_obj = cap
                _STATE.capture_name = "none"
            _log("aura: capture off (Aura disabled or motion does not use audio)")
    except Exception as exc:  # noqa: BLE001 - capture must never break serving
        _log("aura: capture open failed (%s); using silence", type(exc).__name__)
        cap = capture.NullCapture()
        with _STATE.lock:
            _STATE.capture_obj = cap
            _STATE.capture_name = "none"

    last_feature = 0.0
    last_data = time.monotonic()
    last_probe = last_data
    last_gate = last_data
    wanted = cap.name != "none" or _audio_wanted()
    # Idle lifecycle: capture + FFT cost ~4% of a core with nobody watching
    # (measured: aura-capture 3.4%, feeder 0.33%, parec 0.25% at clients=0).
    # After IDLE_STOP_S with no connected page we drop to silence and reopen the
    # moment a page appears again — unless the user asked for background listening.
    idle_since = None
    idle_holding = False
    try:
        while not stop_event.is_set():
            now = time.monotonic()
            if now - last_gate >= CAPTURE_GATE_S:
                last_gate = now
                was_wanted, wanted = wanted, _audio_wanted()
                try:
                    listening = bool(config.load_config().get("listen_background"))
                except Exception:  # noqa: BLE001 - a config read must not stop audio
                    listening = False
                if _STATE.clients:
                    idle_since = None
                elif idle_since is None:
                    idle_since = now
                idle_long = idle_since is not None and (now - idle_since) >= IDLE_STOP_S
                if idle_long and not listening and cap.name != "none":
                    idle_holding = True
                    cap = _swap_capture(cap, capture.NullCapture())
                    frame_silence.reset()
                    _log("aura: capture paused (no listeners for %ds)", int(IDLE_STOP_S))
                    publish_config()
                elif listening or _STATE.clients:
                    if idle_holding:
                        idle_holding = False
                        last_probe = now - CAPTURE_RETRY_S  # reopen right away
                        _log("aura: capture resumed (a listener is back)")
                if not wanted and cap.name != "none":
                    # Off, or a motion that ignores audio: no recorder may stay
                    # open (privacy). Back off to silence without a respawn.
                    cap = _swap_capture(cap, capture.NullCapture())
                    frame_silence.reset()
                    _log("aura: capture off (Aura disabled or motion does not use audio)")
                    publish_config()
                elif wanted and not was_wanted:
                    last_probe = now - CAPTURE_RETRY_S  # reopen right away
            if (wanted and not idle_holding and cap.name == "none" and preferred != "none"
                    and now - last_probe >= CAPTURE_RETRY_S):
                # The first probe can miss audio (busy host at startup, sound
                # server or device not ready yet); never lock in silence.
                last_probe = now
                try:
                    retry = capture.open_capture(preferred)
                except Exception:  # noqa: BLE001
                    retry = None
                if retry is not None and retry.name != "none":
                    cap = _swap_capture(cap, retry)
                    frame_silence.reset()
                    _log("aura: capture backend %s (after retry)", cap.name)
                    publish_config()  # open pages still show "no system audio"
                now = time.monotonic()
            frame = None
            try:
                frame = cap.read(FRAME_SAMPLES)
            except Exception as exc:  # noqa: BLE001
                _log("aura: capture read failed (%s)", type(exc).__name__)
                frame = None
            if frame is None:
                if cap.name != "none" and not _STATE.capture_lost_reported:
                    if now - last_data > 2.0:
                        _STATE.capture_lost_reported = True
                        _broadcast_event({"type": "error", "code": "capture_lost",
                                          "message": "audio capture stopped; visualizer is idle"})
                frame = b"\x00" * (FRAME_SAMPLES * 4)
            else:
                last_data = now
                _STATE.capture_lost_reported = False
            if cap.name == "none":
                # NullCapture returns silence instantly; pace it to real time or
                # this thread spins a full core and starves the host's GIL.
                if stop_event.wait(FRAME_SAMPLES / capture.SAMPLE_RATE):
                    break

            ts_ms = int(now * 1000)
            with _STATE.lock:
                _STATE.pcm_seq += 1
                seq = _STATE.pcm_seq
            # Judge the flag from THIS frame: _STATE.features refreshes only
            # ~10 Hz and starts silent, which used to flag the first frames of
            # music (and frames right after a quiet stretch) as silent.
            silence = frame_silence.is_silent(frame, ts_ms)
            if _clients_snapshot():
                _broadcast_pcm(_ws_pcm_frame(seq, ts_ms, frame, silence))

            if now - last_feature >= FEATURE_INTERVAL_S:
                last_feature = now
                if cap.name == "none":
                    feat = analysis.silence_features()
                else:
                    feat = analyser.analyse(frame, ts_ms=ts_ms)
                with _STATE.lock:
                    _STATE.feature_seq += 1
                    fseq = _STATE.feature_seq
                    _STATE.features = feat
                event = {
                    "type": "features",
                    "seq": fseq,
                    "ts_ms": ts_ms,
                    "level": round(float(feat["level"]), 4),
                    "bands": [round(float(b), 4) for b in feat["bands"]],
                    "onset": bool(feat["onset"]),
                    "centroid": round(float(feat["centroid"]), 4),
                    "flatness": round(float(feat["flatness"]), 4),
                    "silence": bool(feat["silence"]),
                }
                _broadcast_event(event)

            _mood_tick(now)
    finally:
        try:
            cap.close()
        except Exception:  # noqa: BLE001
            pass
        with _STATE.lock:
            _STATE.capture_obj = None


# ---------------------------------------------------------------------------
# the film: reported state + the command queue (Hermes is the remote)
# ---------------------------------------------------------------------------

PLAYER_COMMANDS = ("play", "pause", "toggle", "next", "prev", "seek",
                   "volume", "load", "watch_window", "bring_back",
                   # the CC switch; the active player answers it
                   "captions",
                   # switch the film to one of its real files (or set the
                   # standing smallest/largest rule); the time is kept
                   "quality",
                   # the saved library: the agent queues one of these and the
                   # desktop writes its own settings.
                   "save", "remove")
MAX_QUEUED_COMMANDS = 64
MAX_LIBRARY_ITEMS = 200
_PLAYER_TEXT_MAX = 2000


def _player_text(value: Any, limit: int = _PLAYER_TEXT_MAX) -> str:
    """A string field from a player report: a URL is long, a title is not."""
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _player_library(value: Any) -> list | None:
    """The saved library as the desktop reported it (or ``None``).

    One entry per saved source: ``{label, url, kind}`` with ``kind`` either
    ``playlist`` or ``film``. Anything malformed is dropped rather than
    guessed at, a missing label falls back to the url, and a url is listed
    once — the same de-duplication the desktop's own list applies.
    """
    if not isinstance(value, list):
        return None
    rows: list = []
    seen: set = set()
    for entry in value[:MAX_LIBRARY_ITEMS]:
        if not isinstance(entry, dict):
            continue
        url = _player_text(entry.get("url"))
        if not url or url in seen:
            continue
        seen.add(url)
        kind = _player_text(entry.get("kind"), 32).lower()
        rows.append({
            "label": _player_text(entry.get("label"), 120) or url,
            "url": url,
            "kind": kind if kind in ("playlist", "film") else "film",
        })
    return rows


def _player_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def player_payload() -> dict:
    """The last report from whichever player is active, plus the queue head."""
    with _STATE.lock:
        player = dict(_STATE.player)
        seq = _STATE.command_seq
        library = list(_STATE.library) if isinstance(_STATE.library, list) else None
        stale = (time.time() - float(player.get("ts") or 0)) > 15.0
    if stale and player:
        # A window that stopped reporting (closed, or the server restarted
        # under it) is not still playing: never claim otherwise.
        player["playing"] = False
        player["stale"] = True
    return {"ok": True, "player": player, "seq": seq,
            "library": library, "window": desktop_window.status()}


def report_player(data: Any) -> dict:
    """Merge one state report from the in-app player or the desktop window."""
    if not isinstance(data, dict):
        raise ValueError("report_must_be_object")
    with _STATE.lock:
        player = dict(_STATE.player)
        url = _player_text(data.get("url"))
        if url:
            if url != player.get("url"):
                player.pop("videoId", None)
            player["url"] = url
        label = _player_text(data.get("label"), 200)
        if label:
            player["label"] = label
        title = _player_text(data.get("title"), 200)
        if title:
            player["title"] = title
        for key in ("playing",):
            if isinstance(data.get(key), bool):
                player[key] = bool(data[key])
        for key in ("position", "duration", "volume"):
            value = _player_number(data.get(key))
            if value is not None:
                player[key] = max(0.0, value)
        if isinstance(data.get("videoId"), str):
            player["videoId"] = _player_text(data["videoId"], 64)
        if isinstance(data.get("kind"), str):
            player["kind"] = _player_text(data.get("kind"), 32)
        # the standing smallest/largest rule the desktop holds, so
        # aura_watch action=quality can report it with the film's choices.
        if isinstance(data.get("quality"), str):
            preference = _player_text(data["quality"], 16).strip().lower()
            if preference in quality.PREFERENCES:
                player["quality"] = preference
        if isinstance(data.get("desktop"), bool):
            player["desktop"] = bool(data["desktop"])
        # A transport command that the active player could not
        # apply (next/prev on a single file) says so; the agent reads it back
        # on the following status instead of claiming the skip worked.
        if isinstance(data.get("applied"), bool):
            player["applied"] = bool(data["applied"])
        command = _player_text(data.get("last_command"), 32)
        if command:
            player["last_command"] = command
        # The desktop's saved library rides its report, so aura_watch
        # action=list reads the real list (and remove can resolve a title to a
        # url). A report without a library leaves the
        # last known one alone — the pop-out page has no library to send.
        library = _player_library(data.get("library"))
        if library is not None:
            _STATE.library = library
        player["ts"] = time.time()
        _STATE.player = player
        _STATE.player_seq += 1
        seq = _STATE.player_seq
    return {"ok": True, "seq": seq}


def enqueue_command(data: Any) -> dict:
    """Queue one transport command for the active player; returns its ``seq``."""
    if not isinstance(data, dict):
        raise ValueError("command_must_be_object")
    cmd = str(data.get("cmd") or "").strip().lower()
    if cmd not in PLAYER_COMMANDS:
        raise ValueError(f"cmd must be one of {list(PLAYER_COMMANDS)}")
    command: dict = {"cmd": cmd, "ts": time.time()}
    for key in ("value", "url", "label", "title", "lang", "preference"):
        if key in data and data[key] is not None:
            if key == "value":
                number = _player_number(data[key])
                # the CC switch is a boolean at the tool's edge; it
                # travels as 0/1 so the page has one shape to read.
                if cmd == "captions" and isinstance(data[key], bool):
                    number = 1.0 if data[key] else 0.0
                if cmd in ("seek", "volume") and number is None:
                    raise ValueError(f"{cmd} needs a numeric value")
                if number is not None:
                    command["value"] = number
            elif key == "lang":
                # A language tag and nothing else: it is forwarded to YouTube.
                text = _player_text(data[key], 20).strip()
                if re.fullmatch(r"[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?", text):
                    command["lang"] = text
            elif key == "preference":
                # the standing rule, one of three words; anything else
                # is refused rather than stored.
                text = _player_text(data[key], 16).strip().lower()
                if text not in quality.PREFERENCES:
                    raise ValueError(f"preference must be one of {list(quality.PREFERENCES)}")
                command["preference"] = text
            else:
                text = _player_text(data[key])
                if text:
                    command[key] = text
    if cmd == "captions" and "value" not in command:
        raise ValueError("captions needs a value of 0 or 1")
    if cmd == "seek" and "value" not in command:
        raise ValueError("seek needs a numeric value")
    if cmd == "volume":
        if "value" not in command:
            raise ValueError("volume needs a numeric value between 0 and 1")
        command["value"] = max(0.0, min(1.0, command["value"]))
    if cmd == "load" and not command.get("url"):
        raise ValueError("load needs a url")
    # A load is a URL the page fetches and plays: it gets the same scheme and
    # own-origin rule as the pop-out, whatever sent it.
    if cmd in ("load", "watch_window") and command.get("url"):
        _check_film_url(command["url"])
    # save/remove always name their target: a url is enough to remove; the
    # desktop also resolves a unique label when that is all it gets.
    if cmd == "save" and not command.get("url"):
        raise ValueError("save needs a url")
    if cmd == "remove" and not (command.get("url") or command.get("label")):
        raise ValueError("remove needs a url or a label")
    # One of the item's real files, or the standing rule: never a command with
    # nothing to do.
    if cmd == "quality" and not (command.get("url") or command.get("preference")):
        raise ValueError("quality needs a url or a preference")
    with _STATE.lock:
        _STATE.command_seq += 1
        command["seq"] = _STATE.command_seq
        _STATE.commands.append(command)
        if len(_STATE.commands) > MAX_QUEUED_COMMANDS:
            _STATE.commands = _STATE.commands[-MAX_QUEUED_COMMANDS:]
    return {"ok": True, "seq": command["seq"], "command": command}


def pending_commands(after: Any = 0) -> dict:
    """Commands with ``seq > after`` — the desktop window's poll target."""
    try:
        cursor = int(after)
    except (TypeError, ValueError):
        cursor = 0
    with _STATE.lock:
        pending = [dict(c) for c in _STATE.commands if int(c.get("seq", 0)) > cursor]
        seq = _STATE.command_seq
    return {"ok": True, "seq": seq, "head_seq": seq, "commands": pending}


def window_payload() -> dict:
    """``GET /api/window`` — the pop-out's status, never the token."""
    status = desktop_window.status()
    status["ok"] = True
    return status


def _check_film_url(url: str) -> None:
    """Only an http(s) page Aura itself loads, and never its own token-bearing one.

    The window's ``url`` parameter is shown on the user's screen and loaded by
    Chrome, not by Aura's checked opener, so a page the agent was reading could
    otherwise pop out ``file:``, ``ftp:`` or Aura's own origin. The player takes
    a ``load`` the same way, from a page or a tool call, so both pass through
    here. Other LAN hosts stay allowed: a NAS movie is still a film.
    """
    try:
        parsed = urlsplit(str(url or ""))
    except ValueError as exc:
        raise ValueError("film url is not a valid URL") from exc
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise ValueError("film url must be http(s)")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise ValueError("film url has an invalid port") from exc
    aura_port = _STATE.port
    if (aura_port and port == int(aura_port)
            and parsed.hostname.lower() in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("film url must not be Aura's own page (drop the token URL)")


def open_window(data: Any) -> dict:
    """``POST /api/window/open`` — hand the film to its own OS window."""
    body = data if isinstance(data, dict) else {}
    url = _player_text(body.get("url"))
    if not url:
        with _STATE.lock:
            url = str(_STATE.player.get("url") or "")
    if not url:
        raise ValueError("no film to pop out (send a url or load one first)")
    _check_film_url(url)
    with _STATE.lock:
        reported = dict(_STATE.player)
    position = _player_number(body.get("position"))
    if position is None and (not body.get("url") or url == reported.get("url")):
        position = _player_number(reported.get("position"))
    video_id = _player_text(body.get("videoId"), 64)
    if not video_id and (not body.get("url") or url == reported.get("url")):
        video_id = _player_text(reported.get("videoId"), 64)
    port = _STATE.port
    if not port:
        raise RuntimeError("server_not_running")
    options = {"position": float(position or 0.0), "label": _player_text(body.get("label"), 200)}
    if video_id:
        options["video_id"] = video_id
    playing = body.get("playing")
    if not isinstance(playing, bool) and (not body.get("url") or url == reported.get("url")):
        playing = reported.get("playing")
    if playing is False:
        options["paused"] = True
    # The window starts with the saved caption choice.
    if isinstance(body.get("captions"), bool):
        options["captions"] = body["captions"]
        lang = body.get("lang")
        if isinstance(lang, str) and lang.strip():
            options["lang"] = lang.strip()
    result = desktop_window.open_window(int(port), _STATE.token, url, **options)
    result["ok"] = True
    result["window"] = desktop_window.status()
    return result


def manage_window(data: Any) -> dict:
    """``POST /api/window/manage`` — open a real web page in the window.

    The pop-out is ordinary Chromium on Aura's own persistent profile, so a
    site there behaves like a site: a YouTube playlist can be curated for real
    (add, remove, reorder) with the user's own session — no API scope and no
    account handshake.
    """
    body = data if isinstance(data, dict) else {}
    url = _player_text(body.get("url"), 400)
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("only http(s) pages can be opened")
    # Same rule as the film: never hand Chrome Aura's own token-bearing page.
    _check_film_url(url)
    result = desktop_window.open_page(url)
    result["ok"] = True
    result["window"] = desktop_window.status()
    return result


def close_window() -> dict:
    closed = desktop_window.close_window()
    return {"ok": True, "closed": closed, "window": desktop_window.status()}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"Aura/{VERSION}"
    sys_version = ""

    # -- logging (never the token) ----------------------------------------
    def log_message(self, format, *args):  # noqa: A002,N802
        try:
            logger.debug("aura http: " + redact.redact_text(format % args))
        except Exception:  # noqa: BLE001
            pass

    # -- plumbing ---------------------------------------------------------
    def _port(self) -> int:
        try:
            return int(self.server.server_address[1])
        except (AttributeError, IndexError, TypeError, ValueError):
            return 0

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip()
        port = self._port()
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if host in allowed:
            return True
        # A missing Host on HTTP/1.0 is acceptable only when the port matches.
        return host == "" and port > 0

    def _bearer_ok(self) -> bool:
        header = self.headers.get("Authorization") or ""
        parts = header.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        token = _STATE.token
        if not token:
            return False
        try:
            return hmac.compare_digest(parts[1], token)
        except (TypeError, ValueError):
            return False

    def _query_token(self) -> str:
        try:
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            return (query.get("token") or [""])[0]
        except (ValueError, TypeError):
            return ""

    def _query_ok(self) -> bool:
        token = _STATE.token
        supplied = self._query_token()
        if not token or not supplied:
            return False
        try:
            return hmac.compare_digest(supplied, token)
        except (TypeError, ValueError):
            return False

    def _send_json(self, obj: dict, code: int = 200) -> None:
        try:
            payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            payload = b'{"ok":false}'
            code = 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if code == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _guard(self) -> bool:
        if not self._host_ok():
            self._send_json({"ok": False, "error": "bad_host"}, 403)
            return False
        return True

    def _body_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        if length > MAX_CONTROL_BYTES:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # -- routes -----------------------------------------------------------
    def do_GET(self):  # noqa: N802
        try:
            if not self._guard():
                return
            path = urlsplit(self.path).path
            if path == "/api/stream":
                self._handle_ws()
                return
            if path == "/" or path == "/index.html":
                if not (self._query_ok() or self._bearer_ok()):
                    self._send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
                self._serve_index()
                return
            if path == "/favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path in _STATIC_TYPES or path.startswith("/vendor/"):
                # Static assets are served WITHOUT the token on purpose: the browser
                # fetches <script src> itself and cannot attach an Authorization
                # header, and rewriting every tag with ?token= is brittle. They
                # carry no secrets (our JS + MIT bundles + the preset list); every
                # data endpoint and the WebSocket stay token-gated.
                self._serve_static(path)
                return
            if path == "/api/radio/stream":
                # [finding 9] The page's <audio> src points here, not at the
                # station. The server validates, pins and streams; the browser
                # never resolves a hostname or follows an unchecked redirect.
                if not (self._bearer_ok() or self._query_ok()):
                    self._send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
                self._stream_radio()
                return
            if path == "/api/player/commands":
                # The desktop window's page polls this from its own document: it
                # can send the token in the query string, not as a header. The
                # token is already in that page's URL; nothing new is exposed.
                if not (self._bearer_ok() or self._query_ok()):
                    self._send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
                query = parse_qs(urlsplit(self.path).query)
                after = (query.get("after") or ["0"])[0]
                self._send_json(pending_commands(after))
                return
            if not self._bearer_ok():
                self._send_json({"ok": False, "error": "unauthorized"}, 401)
                return
            if path == "/healthz":
                self._send_json(self._healthz())
            elif path == "/api/state":
                self._send_json(self._state())
            elif path == "/api/presets":
                self._send_json(_presets_payload())
            elif path == "/api/catalog":
                self._send_json(_catalog_payload())
            elif path == "/api/config":
                self._send_json(self._config())
            elif path == "/api/window":
                self._send_json(window_payload())
            elif path == "/api/player":
                self._send_json(player_payload())
            elif path == "/api/quality":
                # The film's real versions. The desktop never talks to
                # archive.org itself: this is the one door, it validates the URL,
                # and it answers from a small cache with a short timeout.
                query = parse_qs(urlsplit(self.path).query)
                self._send_json(quality.choices_for((query.get("url") or [""])[0]))
            else:
                self._send_json({"ok": False, "error": "not_found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            _log("aura: GET %s failed (%s)", urlsplit(self.path).path, type(exc).__name__)
            try:
                self._send_json({"ok": False, "error": "internal"}, 500)
            except Exception:  # noqa: BLE001
                pass

    def do_POST(self):  # noqa: N802
        try:
            if not self._guard():
                return
            path = urlsplit(self.path).path
            if path == "/api/window/bootstrap":
                try:
                    data = self._body_json()
                    ticket = data.get("ticket") if isinstance(data, dict) else None
                    token = desktop_window.redeem_ticket(ticket) if isinstance(ticket, str) else None
                except (ValueError, UnicodeDecodeError):
                    token = None
                if not token or not _STATE.token or not hmac.compare_digest(token, _STATE.token):
                    self._send_json({"ok": False, "error": "invalid_ticket"}, 401)
                else:
                    self._send_json({"ok": True, "token": token})
                return
            player_write = path in ("/api/player/report", "/api/player/command")
            if not self._bearer_ok():
                # The desktop window's own page sends its token in the query
                # string (it cannot attach a header to fetch from a document).
                if not (player_write and self._query_ok()):
                    self._send_json({"ok": False, "error": "unauthorized"}, 401)
                    return
            if path not in ("/api/control", "/api/mood", "/api/config/push",
                            "/api/window/open", "/api/window/close",
                            "/api/window/manage",
                            "/api/player/report", "/api/player/command",
                            "/api/audio"):
                self._send_json({"ok": False, "error": "not_found"}, 404)
                return
            try:
                data = self._body_json()
            except (ValueError, UnicodeDecodeError):
                self._send_json({"ok": False, "error": "bad_json"}, 400)
                return
            if path == "/api/player/report":
                try:
                    self._send_json(report_player(data))
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            if path == "/api/player/command":
                try:
                    self._send_json(enqueue_command(data))
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            if path == "/api/window/manage":
                try:
                    self._send_json(manage_window(data))
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                    return
                except desktop_window.WindowError as exc:
                    self._send_json({"ok": False, "error": str(exc),
                                     "window": desktop_window.status()}, 503)
                    return
                return
            if path in ("/api/window/open", "/api/window/close"):
                try:
                    result = (open_window(data) if path.endswith("/open")
                              else close_window())
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                    return
                except desktop_window.WindowError as exc:
                    self._send_json({"ok": False, "error": str(exc),
                                     "window": desktop_window.status()}, 503)
                    return
                except RuntimeError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 503)
                    return
                self._send_json(result)
                return
            # [listen lane] A follower forwards this to the leader; the leader
            # records it and the desktop picks it up from /api/state.
            if path == "/api/audio":
                try:
                    request = _validate_audio_request(data)
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                    return
                stored = publish_audio_request(**request)
                self._send_json({"ok": True, "audio_request": stored})
                return
            if path == "/api/mood":
                try:
                    mood, intensity, ttl_ms = _validate_mood(data)
                except ValueError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 400)
                    return
                publish_mood(mood, intensity, ttl_ms)
                self._send_json({"ok": True, "mood": mood})
                return
            if path == "/api/config/push":
                publish_config()
                self._send_json({"ok": True})
                return
            try:
                applied = _apply_control(data)
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            self._send_json({"ok": True, "applied": applied})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            _log("aura: POST failed (%s)", type(exc).__name__)
            try:
                self._send_json({"ok": False, "error": "internal"}, 500)
            except Exception:  # noqa: BLE001
                pass

    # -- payloads ---------------------------------------------------------
    def _healthz(self) -> dict:
        with _STATE.lock:
            return {
                "ok": True,
                "version": VERSION,
                "pid": os.getpid(),
                "capture": _STATE.capture_name,
                "rate": SAMPLE_RATE,
                "clients": len(_STATE.clients),
            }

    def _state(self) -> dict:
        cfg = config.load_config()
        with _STATE.lock:
            feat = dict(_STATE.features)
            payload = {
                "type": "features",
                "seq": _STATE.feature_seq,
                "ts_ms": int(time.monotonic() * 1000),
                "level": feat.get("level", 0.0),
                "bands": list(feat.get("bands", [0.0] * 8)),
                "onset": bool(feat.get("onset", False)),
                "centroid": feat.get("centroid", 0.0),
                "flatness": feat.get("flatness", 0.0),
                "silence": bool(feat.get("silence", True)),
                "enabled": bool(cfg["enabled"]),
                "mood": _STATE.mood,
                "intensity": cfg["intensity"],
                "sessions": _STATE.session_count,
                "session_boost": _STATE.session_boost,
                "preset": cfg["preset"] or _STATE.preset,
                "opacity": cfg["opacity"],
                "behavior": cfg["behavior"],
                "mood_reactive": bool(cfg["mood_reactive"]),
                "accent_pulse": bool(cfg["accent_pulse"]),
                "auto_preset": bool(cfg["auto_preset"]),
                "motion": cfg["motion"],
                "idle_motion": cfg["idle_motion"],
                "reduced_motion": bool(cfg["reduced_motion"]),
                # [listen lane] The desktop half polls this; `None` means
                # "nothing to do". The list carries every unapplied request in
                # order so play-then-mute does not lose the play. See
                # publish_audio_request().
                "audio_requests": [dict(r) for r in _STATE.audio_requests],
                "audio_request": dict(_STATE.audio_request) if _STATE.audio_request else None,
            }
        return payload

    def _config(self) -> dict:
        cfg = config.load_config()
        return {
            "intensity": cfg["intensity"],
            **_session_boost_snapshot(),
            "reduced_motion": cfg["reduced_motion"],
            "capture": _STATE.capture_name,
            "theme_opt_in": cfg["theme_opt_in"],
            "enabled": bool(cfg["enabled"]),
            "preset": cfg["preset"],
            "opacity": cfg["opacity"],
            "behavior": cfg["behavior"],
            "mood_reactive": bool(cfg["mood_reactive"]),
            "accent_pulse": bool(cfg["accent_pulse"]),
            "auto_preset": bool(cfg["auto_preset"]),
            "motion": cfg["motion"],
            "idle_motion": cfg["idle_motion"],
            "behavior_profile": behavior.profile(cfg["behavior"]),
        }

    def _stream_radio(self) -> None:
        """Proxy one validated radio stream to the page's <audio> element."""
        try:
            query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
            url = (query.get("url") or [""])[0]
        except (TypeError, ValueError):
            url = ""
        started = False
        try:
            with radio.open_stream(url) as response:
                ctype = _proxy_content_type(response.headers.get("Content-Type"))
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                # A station is third-party input: never let its bytes execute
                # in Aura's origin, even if a browser ignores the fixed type.
                self.send_header("Content-Security-Policy", STREAM_CSP)
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                started = True
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except radio.RadioError as exc:
            if not started:
                self._send_json({"ok": False, "error": str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001 - the stream is best-effort
            _log("aura: radio stream failed (%s)", type(exc).__name__)
            if not started:
                try:
                    self._send_json({"ok": False, "error": "stream_failed"}, 502)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass

    def _serve_static(self, path: str) -> None:
        """Serve one whitelisted asset from web/, refusing anything outside it."""
        rel = path.lstrip("/")
        if rel.startswith("vendor/"):
            if rel.count("/") != 1:
                self._send_json({"ok": False, "error": "not_found"}, 404)
                return
            ctype = _VENDOR_TYPES.get(Path(rel).suffix.lower(), "application/octet-stream")
        else:
            ctype = _STATIC_TYPES.get(path)
            if ctype is None:
                self._send_json({"ok": False, "error": "not_found"}, 404)
                return
        try:
            target = (WEB_DIR / rel).resolve()
            if not target.is_relative_to(WEB_DIR.resolve()) or not target.is_file():
                raise OSError("outside web/ or missing")
            payload = target.read_bytes()
        except (OSError, ValueError):
            # A path with an embedded NUL byte makes resolve() raise ValueError;
            # a hostile request is a refusal, never a 500.
            self._send_json({"ok": False, "error": "not_found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _serve_index(self) -> None:
        index = WEB_DIR / "index.html"
        try:
            payload = index.read_bytes()
            ctype = "text/html; charset=utf-8"
        except OSError:
            payload = (
                "<!doctype html><meta charset=utf-8><title>Aura</title>"
                "<body style='font:14px system-ui;background:#111;color:#eee'>"
                "<h1>Aura</h1><p>Server is running. The visualizer page is not installed.</p>"
            ).encode("utf-8")
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # -- websocket --------------------------------------------------------
    def _is_upgrade(self) -> bool:
        upgrade = (self.headers.get("Upgrade") or "").lower()
        connection = (self.headers.get("Connection") or "").lower()
        return upgrade == "websocket" and "upgrade" in connection

    def _handle_ws(self) -> None:
        if not self._is_upgrade():
            self._send_json({"ok": False, "error": "upgrade_required"}, 426)
            return
        key = self.headers.get("Sec-WebSocket-Key") or ""
        if not key:
            self._send_json({"ok": False, "error": "bad_handshake"}, 400)
            return

        self.close_connection = True
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", _ws_accept(key))
        self.end_headers()
        try:
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

        sock = self.connection
        try:
            sock.settimeout(None)  # the reader blocks; close() shuts it down
        except OSError:
            pass

        if not self._query_ok():
            # §1/§6: bad token on WS -> close 1008, never a silent blank frame.
            try:
                sock.sendall(_ws_close_frame(1008, "invalid token"))
            except OSError:
                pass
            return

        client = _Client(sock)
        with _STATE.lock:
            _STATE.clients.add(client)
        _log("aura: ws client connected (%d total)", len(_clients_snapshot()))

        reader = threading.Thread(target=self._ws_reader, args=(client,),
                                  name="aura-ws-reader", daemon=True)
        reader.start()
        try:
            while not _STATE.stop_event.is_set() and not client.closed:
                item = client.pop(0.2)
                if item is None:
                    continue
                opcode, payload = item
                try:
                    client.send(opcode, payload)
                except (OSError, ValueError):
                    break
        finally:
            with _STATE.lock:
                _STATE.clients.discard(client)
                remaining = len(_STATE.clients)
                if remaining == 0:
                    # §4: when the page is gone, mood state must not survive.
                    _STATE.mood = "idle"
                    _STATE.mood_intensity = 0.0
                    _STATE.mood_expiry = None
                    _STATE.mood_ttl_ms = 0
            client.close()
            _log("aura: ws client gone (%d left)", remaining)

    def _ws_reader(self, client: _Client) -> None:
        """Read client frames (masked). Only ping/pong/close matter (§2)."""
        reader = self.rfile
        try:
            while not client.closed:
                header = _read_exact(reader, 2)
                if header is None:
                    break
                b0, b1 = struct.unpack("BB", header)
                opcode = b0 & 0x0F
                masked = bool(b1 & 0x80)
                length = b1 & 0x7F
                if length == 126:
                    ext = _read_exact(reader, 2)
                    if ext is None:
                        break
                    length = struct.unpack(">H", ext)[0]
                elif length == 127:
                    ext = _read_exact(reader, 8)
                    if ext is None:
                        break
                    length = struct.unpack(">Q", ext)[0]
                if length > 1_000_000:
                    break
                mask = _read_exact(reader, 4) if masked else None
                if masked and mask is None:
                    break
                payload = _read_exact(reader, length) if length else b""
                if payload is None:
                    break
                if mask:
                    payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
                if opcode == 0x8:  # close
                    try:
                        client.send(0x8, struct.pack(">H", 1000))
                    except OSError:
                        pass
                    break
                if opcode == 0x9:  # ping
                    try:
                        client.send(0xA, payload)
                    except OSError:
                        break
                    continue
                if opcode == 0x1:  # text
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if isinstance(msg, dict) and msg.get("type") == "ping":
                        client.push_event({"type": "pong"})
        except (OSError, ValueError):
            pass
        finally:
            client.close()


def _read_exact(source, n: int) -> bytes | None:
    """Read exactly n bytes from a socket or buffered file; None on EOF/error."""
    chunks = []
    remaining = n
    while remaining > 0:
        try:
            chunk = source.recv(remaining) if isinstance(source, socket.socket) else source.read(remaining)
        except (OSError, socket.timeout):
            return None
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# control application
# ---------------------------------------------------------------------------

def _validate_mood(data) -> tuple[str, float, int]:
    """Validate a /api/mood body; raise ValueError with a machine code."""
    if not isinstance(data, dict):
        raise ValueError("body_must_be_object")
    mood = data.get("mood")
    if not isinstance(mood, str) or mood not in MOODS:
        raise ValueError("bad_mood")
    intensity = data.get("intensity", 1.0)
    if isinstance(intensity, bool) or not isinstance(intensity, (int, float)):
        raise ValueError("intensity_must_be_number")
    intensity = max(0.0, min(1.0, float(intensity)))
    ttl_ms = data.get("ttl_ms", 0)
    if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, (int, float)):
        raise ValueError("ttl_ms_must_be_number")
    ttl_ms = max(0, int(ttl_ms))
    return mood, intensity, ttl_ms


def _validate_audio_request(data) -> dict:
    """Validate an /api/audio body; raise ValueError with a machine code.

    Kept separate from ``_validate_control`` so a bad audio action can never
    take the display controls down with it.
    """
    if not isinstance(data, dict):
        raise ValueError("body_must_be_object")
    action = data.get("action", "play")
    if not isinstance(action, str) or action not in AUDIO_ACTIONS:
        raise ValueError("bad_audio_action")
    url = data.get("url", "")
    label = data.get("label", "")
    if url is None:
        url = ""
    if label is None:
        label = ""
    if not isinstance(url, str):
        raise ValueError("url_must_be_string")
    if not isinstance(label, str):
        raise ValueError("label_must_be_string")
    request: dict[str, Any] = {"action": action, "url": url.strip()[:2048], "label": label.strip()[:200]}
    if action == "play" and not request["url"]:
        raise ValueError("url_required_for_play")
    if action == "volume":
        value = data.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("volume_must_be_number")
        value = float(value)
        if not 0.0 <= value <= 1.0:
            raise ValueError("volume_out_of_range")
        request["value"] = value
    return request


def _validate_control(data) -> dict:
    """Validate a /api/control body; raise ValueError with a machine code."""
    if not isinstance(data, dict):
        raise ValueError("body_must_be_object")
    applied = {}
    if "enabled" in data:
        if not isinstance(data["enabled"], bool):
            raise ValueError("enabled_must_be_bool")
        applied["enabled"] = data["enabled"]
    if "intensity" in data:
        value = data["intensity"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("intensity_must_be_number")
        value = float(value)
        if not 0.0 <= value <= 1.0:
            raise ValueError("intensity_out_of_range")
        applied["intensity"] = value
    if "preset" in data:
        value = data["preset"]
        if value is not None and not isinstance(value, str):
            raise ValueError("preset_must_be_string_or_null")
        applied["preset"] = value.strip() if isinstance(value, str) else None
        if applied["preset"] == "":
            applied["preset"] = None
    if "mood" in data:
        value = data["mood"]
        if not isinstance(value, str) or value not in MOODS:
            raise ValueError("bad_mood")
        applied["mood"] = value
    if "opacity" in data:
        value = data["opacity"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("opacity_must_be_number")
        value = float(value)
        if not 0.0 <= value <= 1.0:
            raise ValueError("opacity_out_of_range")
        applied["opacity"] = value
    if "behavior" in data:
        value = data["behavior"]
        if not isinstance(value, str):
            raise ValueError("behavior_must_be_string")
        value = value.strip().lower()
        if value not in behavior.BEHAVIORS:
            raise ValueError("bad_behavior")
        applied["behavior"] = value
    if "motion" in data:
        value = data["motion"]
        if not isinstance(value, str):
            raise ValueError("motion_must_be_string")
        value = value.strip().lower()
        if value not in config.MOTIONS:
            raise ValueError("bad_motion")
        applied["motion"] = value
    if "idle_motion" in data:
        value = data["idle_motion"]
        if not isinstance(value, str):
            raise ValueError("idle_motion_must_be_string")
        value = value.strip().lower()
        if value not in config.IDLE_MOTIONS:
            raise ValueError("bad_idle_motion")
        applied["idle_motion"] = value
    for toggle in ("mood_reactive", "accent_pulse", "auto_preset", "reduced_motion"):
        if toggle in data:
            if not isinstance(data[toggle], bool):
                raise ValueError(toggle + "_must_be_bool")
            applied[toggle] = data[toggle]
    return applied


def _apply_control(data) -> dict:
    applied = _validate_control(data)
    patch = {k: v for k, v in applied.items()
             if k in ("enabled", "intensity", "preset", "opacity", "behavior",
                      "mood_reactive", "accent_pulse", "auto_preset", "motion",
                      "idle_motion", "reduced_motion")}
    if patch:
        cfg = config.merge_config(patch)
        if "preset" in applied:
            with _STATE.lock:
                _STATE.preset = cfg["preset"]
        _broadcast_event(_config_event())
    if applied.get("mood_reactive") is False:
        # The agent-mood layer is off: no leftover mood, no latched pulse.
        with _STATE.lock:
            _STATE.mood = "idle"
            _STATE.mood_intensity = 0.0
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
    if "mood" in applied:
        publish_mood(applied["mood"], 1.0, 0)
    if applied.get("enabled") is False:
        # §4: disabling Aura clears mood state; re-enable starts at idle.
        with _STATE.lock:
            _STATE.mood = "idle"
            _STATE.mood_intensity = 0.0
            _STATE.mood_expiry = None
            _STATE.mood_ttl_ms = 0
    return applied


# ---------------------------------------------------------------------------
# server lifecycle
# ---------------------------------------------------------------------------

class _Httpd(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):  # noqa: N802
        try:
            exc = getattr(self, "_last_exc", None)
            logger.debug("aura: connection error (%s)", type(exc).__name__ if exc else "?")
        except Exception:  # noqa: BLE001
            pass


def _start_server() -> None:
    """Create the socket, bind, and start serving + capture in daemon threads.

    The caller must hold the leader lock (``_try_become_leader``).
    """
    # A restart (the previous http thread died) must not leak the old listener:
    # _try_become_leader calls this again the moment _server_running() goes false.
    with _STATE.lock:
        stale = _STATE.httpd
        _STATE.httpd = None
    if stale is not None:
        try:
            stale.server_close()
        except Exception:  # noqa: BLE001 - the old socket may already be gone
            pass

    token = secrets.token_urlsafe(32)
    try:
        config.write_token(token)
    except OSError as exc:
        _log("aura: token file write failed (%s)", type(exc).__name__)

    httpd = _Httpd(("127.0.0.1", 0), _Handler)
    port = int(httpd.server_address[1])

    stop_event = threading.Event()
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1},
                              name="aura-http", daemon=True)

    with _STATE.lock:
        _STATE.token = token
        _STATE.httpd = httpd
        _STATE.port = port
        _STATE.stop_event = stop_event
        _STATE.thread = thread
        _STATE.capture_name = "none"
        _STATE.features = analysis.silence_features()
        _STATE.feature_seq = 0
        _STATE.pcm_seq = 0
        _STATE.capture_lost_reported = False
        _STATE.player = {}
        _STATE.player_seq = 0
        _STATE.library = None
        _STATE.commands = []
        _STATE.command_seq = 0
        _STATE.audio_requests = []
        _STATE.audio_request = None

    thread.start()
    cap_thread = threading.Thread(target=_capture_loop, args=(stop_event,),
                                  name="aura-capture", daemon=True)
    with _STATE.lock:
        _STATE.capture_thread = cap_thread
        _STATE.session_count = 0
        _STATE.session_boost = 1.0
    cap_thread.start()
    _write_lease(token, port)
    threading.Thread(target=_lease_loop, args=(stop_event,), name="aura-lease", daemon=True).start()
    # A window left behind by a previous server holds a dead token: close it,
    # before it plays audio nobody can control.
    try:
        desktop_window.reap_orphan()
    except Exception as exc:  # noqa: BLE001 - reaping is best-effort
        _log("aura: window reap failed (%s)", type(exc).__name__)
    _log("aura: listening on 127.0.0.1:%d (pid %d)", port, os.getpid())


# ---------------------------------------------------------------------------
# leader election helpers
# ---------------------------------------------------------------------------

def _pid_alive(pid: Any) -> bool:
    """True when ``pid`` is a live process.

    Windows needs its own probe: there ``os.kill(pid, 0)`` is not a liveness check, because signal
    0 is CTRL_C_EVENT, so CPython sends a console Ctrl+C event to the process group instead of
    asking whether the pid exists. A follower trusts this to accept the leader lease, so the wrong
    answer either rejects a live leader (the pane then gets no port or token) or fires a Ctrl+C at
    whatever shares the console.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _pid_alive_windows(pid: int) -> bool:
    """``OpenProcess`` + ``GetExitCodeProcess``: the Windows liveness probe."""
    if pid == os.getpid():
        return True
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            # Access denied means the process exists but is beyond our reach (an elevated one).
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        finally:
            kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    except Exception:  # noqa: BLE001 - a probe never takes the election down
        return False


def _write_lease(token: str, port: int) -> None:
    """Advertise the leader to followers.  Never logs the token."""
    try:
        config.write_lease({
            "pid": os.getpid(),
            "port": int(port),
            "token": token,
            "started": time.time(),
            "capture": _STATE.capture_name,
        })
    except OSError as exc:
        _log("aura: lease write failed (%s)", type(exc).__name__)


# How often a leader checks that the lease and the token file still name its own server.
LEASE_CHECK_S = 2.0


def _holds_lock() -> bool:
    """True only in a process that won the election lock (flock, or the Windows mutex)."""
    return _LOCK_FD is not None or _WIN_MUTEX is not None


def _reassert_lease() -> bool:
    """Leader only: put this server back into the lease and token file after another writer.

    The lease is advertised once at start. A process that won the election in a gap and then
    exited leaves the file naming a dead pid and port, and every reader that relies on it (a
    follower module in this same process, the CLI, the tools) then finds no server at all.
    Only the lock holder rewrites, so two servers can never take turns overwriting each other.
    """
    if not _holds_lock():
        return False
    with _STATE.lock:
        token, port = _STATE.token, _STATE.port
    if not token or not port or not _server_running():
        return False
    changed = False
    lease = config.read_lease()
    if not (isinstance(lease, dict) and lease.get("pid") == os.getpid()
            and lease.get("port") == port and lease.get("token") == token):
        _write_lease(token, port)
        changed = True
    if config.read_token() != token:
        try:
            config.write_token(token)
        except OSError as exc:
            _log("aura: token file write failed (%s)", type(exc).__name__)
        changed = True
    if changed:
        _log("aura: lease re-advertised by pid %d on port %d", os.getpid(), port)
    return changed


def _lease_loop(stop_event: threading.Event) -> None:
    while not stop_event.wait(LEASE_CHECK_S):
        try:
            _reassert_lease()
        except Exception as exc:  # noqa: BLE001 - the check must never take the server down
            _log("aura: lease check failed (%s)", type(exc).__name__)


def _valid_lease() -> dict | None:
    """The leader advertisement, but only while that pid is alive."""
    lease = config.read_lease()
    if not isinstance(lease, dict):
        return None
    pid = lease.get("pid")
    port = lease.get("port")
    token = lease.get("token")
    if not _pid_alive(pid):
        return None
    if not isinstance(port, int) or isinstance(port, bool) or port <= 0:
        return None
    if not isinstance(token, str) or not token:
        return None
    return lease


def _follower_lease() -> dict | None:
    """A lease we may follow: never our own stale advertisement after stop."""
    lease = _valid_lease()
    if lease is None:
        return None
    if lease.get("pid") == os.getpid() and not _FOLLOWING:
        return None
    return lease


def _try_acquire_lock() -> bool:
    """Non-blocking leader lock.  Windows (no fcntl) behaves as before."""
    global _LOCK_FD, _LOCK_HOME
    if _LOCK_FD is not None:
        return True
    if fcntl is None:
        # Windows: the flock's counterpart is the named mutex (_try_acquire_win_mutex).
        if os.name == "nt":
            return _try_acquire_win_mutex()
        return True
    try:
        config._ensure_dir()
        fd = os.open(str(config.lock_path()), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        _log("aura: lock open failed (%s)", type(exc).__name__)
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        return False
    _LOCK_FD = fd
    _LOCK_HOME = _home_key()
    return True


def _release_lock() -> None:
    global _LOCK_FD, _LOCK_HOME, _TAKEOVER_AT, _FOLLOWING
    fd = _LOCK_FD
    _LOCK_FD = None
    _LOCK_HOME = None
    _TAKEOVER_AT = 0.0
    _FOLLOWING = False
    if fd is None:
        _release_win_mutex()
        return
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def _is_leader() -> bool:
    if fcntl is None and os.name != "nt":
        return True
    if _LOCK_FD is not None or _WIN_MUTEX is not None:
        return True
    with _STATE.lock:
        return _STATE.httpd is not None


def _server_running() -> bool:
    with _STATE.lock:
        return (_STATE.httpd is not None and _STATE.thread is not None
                and _STATE.thread.is_alive())


def _try_become_leader() -> bool:
    """Retry the leader lock at most once per 2 s; start serving if acquired.

    The caller must hold ``_START_LOCK``.
    """
    global _TAKEOVER_AT, _FOLLOWING, _LOCK_HOME
    if not _is_own_home():
        # A per-turn override points at another profile: never elect/start a
        # second server here; the caller forwards to that home's leader.
        _FOLLOWING = True
        return False
    if fcntl is None and os.name != "nt":
        _FOLLOWING = False
        _LOCK_HOME = _home_key()
        if not _server_running():
            _start_server()
        return True
    if _LOCK_FD is not None or _WIN_MUTEX is not None:
        _FOLLOWING = False
        if not _server_running():
            _start_server()
        return True
    now = time.monotonic()
    with _TAKEOVER_LOCK:
        if now < _TAKEOVER_AT:
            return False
        _TAKEOVER_AT = now + 2.0
    if not _try_acquire_lock():
        _FOLLOWING = True
        return False
    _FOLLOWING = False
    _start_server()
    return True


def _current_lease() -> dict | None:
    """A valid leader lease for the *current* home, excluding our own server."""
    lease = _valid_lease()
    if lease is None or lease.get("pid") == os.getpid():
        return None
    return lease


def _forward_target() -> dict | None:
    """Lease to forward to for the current home, or ``None`` to publish locally."""
    if _is_own_home():
        with _START_LOCK:
            leader = _is_leader()
            if not leader and _FOLLOWING:
                _try_become_leader()
                leader = _is_leader()
        if leader and _server_running():
            return None
        lease = _follower_lease()
        return lease
    return _current_lease()


def _forward(path: str, body: dict, lease: dict) -> None:
    """Fire-and-forget POST to the leader; never blocks or raises into a hook.

    ``lease`` is the one for the *current* home, captured by the caller before
    this thread starts.
    """
    port = lease.get("port")
    token = lease.get("token")
    if not isinstance(port, int) or isinstance(port, bool) or port <= 0:
        return
    if not isinstance(token, str) or not token:
        return

    def _post() -> None:
        try:
            data = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}{path}",
                data=data,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Content-Length": str(len(data)),
                    "Authorization": f"Bearer {token}",
                },
            )
            with urllib.request.urlopen(req, timeout=0.5) as resp:
                resp.read()
        except Exception:  # noqa: BLE001 - a forward must never break a turn
            pass

    threading.Thread(target=_post, name="aura-forward", daemon=True).start()


# ---------------------------------------------------------------------------
# public internal API (CONTRACT §7) — all swallow-and-log
# ---------------------------------------------------------------------------

def ensure_server() -> None:
    """Start the server in a daemon thread if it is not running. Idempotent.

    Only the process's own home is ever elected. Under a per-turn override
    pointing at another profile this call must not start a second server.
    """
    try:
        with _START_LOCK:
            if _server_running():
                return
            if not _is_own_home():
                return
            _try_become_leader()
    except Exception as exc:  # noqa: BLE001 - never block register()/a hook
        _log("aura: server start failed (%s)", type(exc).__name__)


def get_port() -> int | None:
    """Live port for the *current* home (ours, or its leader's), else ``None``."""
    try:
        if _is_own_home():
            if _server_running():
                with _STATE.lock:
                    return _STATE.port
            # Only a follower (or a lock holder whose thread died) retries here;
            # a fresh/stopped process must not start a server just from get_port().
            if _FOLLOWING or _LOCK_FD is not None or _WIN_MUTEX is not None:
                with _START_LOCK:
                    if not _server_running():
                        _try_become_leader()
                if _server_running():
                    with _STATE.lock:
                        return _STATE.port
            lease = _follower_lease()
        else:
            lease = _current_lease()
        if lease is None:
            return None
        return int(lease["port"])
    except Exception:  # noqa: BLE001
        return None


def get_token() -> str | None:
    """Token for the current home (in-process, or its leader's). Never log raw."""
    try:
        if _is_own_home() and _server_running():
            with _STATE.lock:
                return _STATE.token
        lease = _follower_lease() if _is_own_home() else _current_lease()
        if lease is None:
            return None
        return lease.get("token")
    except Exception:  # noqa: BLE001
        return None


def get_capture() -> str:
    try:
        if _is_own_home() and _server_running():
            with _STATE.lock:
                return _STATE.capture_name
        lease = _follower_lease() if _is_own_home() else _current_lease()
        if lease is None:
            return "none"
        capture_name = lease.get("capture")
        return capture_name if isinstance(capture_name, str) else "none"
    except Exception:  # noqa: BLE001
        return "none"


def publish_mood(mood: str, intensity: float = 1.0, ttl_ms: int = 0) -> None:
    """Queue a mood transition for connected pages. No-op with no clients."""
    try:
        if not isinstance(mood, str) or mood not in MOODS:
            return
        if isinstance(intensity, bool) or not isinstance(intensity, (int, float)):
            intensity = 1.0
        intensity = max(0.0, min(1.0, float(intensity)))
        try:
            ttl_ms = max(0, int(ttl_ms))
        except (TypeError, ValueError):
            ttl_ms = 0
        # mood_reactive=false stops the mood layer cleanly: a mood event still
        # reaches pages (as idle) so nothing latches, but no mood is held.
        try:
            reactive = bool(config.get("mood_reactive", True))
        except Exception:  # noqa: BLE001
            reactive = True
        if not reactive:
            mood, intensity, ttl_ms = "idle", 0.0, 0
        # Route at call time: the current home may be a per-turn profile
        # override, not the home this process serves.
        lease = _forward_target()
        if lease is not None:
            _forward("/api/mood", {"mood": mood, "intensity": intensity,
                                   "ttl_ms": ttl_ms}, lease)
            return
        now = time.monotonic()
        with _STATE.lock:
            if mood != _STATE.mood:
                _STATE.mood_prev = _STATE.mood
                _STATE.mood_prev_intensity = _STATE.mood_intensity
            _STATE.mood = mood
            _STATE.mood_intensity = intensity
            _STATE.mood_ttl_ms = ttl_ms
            _STATE.mood_expiry = (now + ttl_ms / 1000.0) if ttl_ms > 0 else None
            _STATE.mood_last_sent = now
        if _clients_snapshot():
            _broadcast_event(_mood_event(mood, intensity, ttl_ms))
    except Exception as exc:  # noqa: BLE001 - a broken mood must not break a turn
        _log("aura: publish_mood failed (%s)", type(exc).__name__)


def publish_audio_request(url: str = "", label: str = "", action: str = "play",
                          value: Any = None) -> dict:
    """[listen lane] Record what the desktop's audio channel should do next.

    Stored in ``/api/state`` as ``audio_requests = [{url, label, seq, at,
    action[, value]}]`` (newest last) and mirrored in ``audio_request`` for
    older desktop builds. The desktop half applies every request whose ``seq``
    it has not seen, in order, remembers the last seq in its own settings and
    ignores requests older than 60 s on its first poll. Returns the stored
    frame.

    Never raises: a broken audio request must not break an agent turn.
    """
    if action not in AUDIO_ACTIONS:
        action = "play"
    try:
        if value is not None:
            value = max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        value = None
    frame_extra: dict[str, Any] = {"action": action, "url": str(url or "")[:2048], "label": str(label or "")[:200]}
    if value is not None:
        frame_extra["value"] = value
    try:
        lease = _forward_target()
        if lease is not None:
            _forward("/api/audio", frame_extra, lease)
            # The follower cannot know the leader's seq; it reports what it sent.
            return {**frame_extra, "seq": 0, "at": int(time.time() * 1000), "forwarded": True}
        with _STATE.lock:
            # Seq must keep growing across a server restart: the desktop
            # remembers "the last seq I played" in its settings, and a fresh
            # process that restarted numbering at 1 would have every new
            # request look like history. Milliseconds are monotonic here, and
            # +1 keeps two requests in the same millisecond distinct.
            now_ms = int(time.time() * 1000)
            _STATE.audio_seq = max(_STATE.audio_seq + 1, now_ms)
            stored = {**frame_extra, "seq": _STATE.audio_seq, "at": now_ms}
            _STATE.audio_request = stored
            _STATE.audio_requests.append(stored)
            if len(_STATE.audio_requests) > MAX_QUEUED_COMMANDS:
                _STATE.audio_requests = _STATE.audio_requests[-MAX_QUEUED_COMMANDS:]
        return dict(stored)
    except Exception as exc:  # noqa: BLE001 - a broken audio request must not break a turn
        _log("aura: publish_audio_request failed (%s)", type(exc).__name__)
        return {**frame_extra, "seq": 0, "at": int(time.time() * 1000), "error": type(exc).__name__}


def publish_config() -> None:
    """Push the current config to connected pages (after a control change)."""
    try:
        lease = _forward_target()
        if lease is not None:
            _forward("/api/config/push", {}, lease)
            return
        if _clients_snapshot():
            _broadcast_event(_config_event())
    except Exception as exc:  # noqa: BLE001
        _log("aura: publish_config failed (%s)", type(exc).__name__)


def stop_server() -> None:
    """Clean shutdown: close sockets, join threads, leave no listener."""
    with _START_LOCK:
        with _STATE.lock:
            was_leader = _STATE.httpd is not None
            our_token = _STATE.token
        _stop_server_locked()
        _release_lock()
        if was_leader:
            lease = config.read_lease()
            if (isinstance(lease, dict)
                    and lease.get("pid") == os.getpid()
                    and lease.get("token") == our_token):
                try:
                    config.lease_path().unlink()
                except OSError:
                    pass


def _stop_server_locked() -> None:
    try:
        with _STATE.lock:
            httpd = _STATE.httpd
            thread = _STATE.thread
            cap_thread = _STATE.capture_thread
            session_thread = _STATE.session_thread
            stop_event = _STATE.stop_event
            clients = list(_STATE.clients)
            _STATE.httpd = None
            _STATE.thread = None
            _STATE.port = None
            _STATE.capture_thread = None
            _STATE.session_thread = None
        if stop_event is not None:
            stop_event.set()
        for client in clients:
            client.close()
        if httpd is not None:
            try:
                httpd.shutdown()
            except Exception:  # noqa: BLE001
                pass
            try:
                httpd.server_close()
            except Exception:  # noqa: BLE001
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=3.0)
        if cap_thread is not None and cap_thread.is_alive():
            cap_thread.join(timeout=3.0)
        if session_thread is not None and session_thread.is_alive():
            session_thread.join(timeout=3.0)
        with _STATE.lock:
            _STATE.clients.clear()
            _STATE.token = None
            _STATE.capture_name = "none"
            _STATE.features = analysis.silence_features()
            _STATE.mood = "idle"
            _STATE.mood_expiry = None
            _STATE.session_count = 0
            _STATE.session_boost = 1.0
            _STATE.player = {}
            _STATE.commands = []
            _STATE.audio_requests = []
            _STATE.audio_request = None
        # The pop-out cannot outlive the server it polls (its token just died).
        try:
            desktop_window.close_window()
        except Exception as exc:  # noqa: BLE001 - shutdown must finish
            _log("aura: window close failed (%s)", type(exc).__name__)
        _log("aura: server stopped")
    except Exception as exc:  # noqa: BLE001
        _log("aura: stop_server failed (%s)", type(exc).__name__)
