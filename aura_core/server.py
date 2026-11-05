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
import secrets
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import analysis, config, redact
from .capture import base as capture

logger = logging.getLogger("aura.server")

VERSION = "0.1.0"
SAMPLE_RATE = 48000
FRAME_SAMPLES = 1024
FEATURE_INTERVAL_S = 0.1  # ≤10 Hz (§2)
MOOD_KEEPALIVE_S = 2.0
MAX_CONTROL_BYTES = 64 * 1024
MAX_WS_QUEUE_PCM = 4      # ~85 ms of audio; older frames are dropped
MAX_WS_QUEUE_EVENT = 64

MOODS = ("idle", "thinking", "tool", "approval", "error", "streaming", "done")

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


_STATE = _State()


def _log(msg: str, *args) -> None:
    """Log without ever leaking the token."""
    try:
        logger.info(redact.redact_text(msg % args if args else msg))
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


def _config_event() -> dict:
    cfg = config.load_config()
    return {
        "type": "config",
        "intensity": cfg["intensity"],
        "reduced_motion": cfg["reduced_motion"],
        "capture": _STATE.capture_name,
        "theme_opt_in": cfg["theme_opt_in"],
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
            _STATE.mood = _STATE.mood_prev
            _STATE.mood_intensity = _STATE.mood_prev_intensity
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


# ---------------------------------------------------------------------------
# capture / feature pump
# ---------------------------------------------------------------------------

def _capture_loop(stop_event: threading.Event) -> None:
    analyser = analysis.Analyser()
    cap = None
    try:
        preferred = config.capture_override()
        if preferred and preferred not in ("pipewire", "pulse", "wasapi", "macos", "none"):
            preferred = None
        cap = capture.open_capture(preferred)
        with _STATE.lock:
            _STATE.capture_obj = cap
            _STATE.capture_name = cap.name
        _log("aura: capture backend %s", cap.name)
    except Exception as exc:  # noqa: BLE001 - capture must never break serving
        _log("aura: capture open failed (%s); using silence", type(exc).__name__)
        cap = capture.NullCapture()
        with _STATE.lock:
            _STATE.capture_obj = cap
            _STATE.capture_name = "none"

    last_feature = 0.0
    last_data = time.monotonic()
    try:
        while not stop_event.is_set():
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
                if cap.name == "none":
                    time.sleep(0.02)
            else:
                last_data = now
                _STATE.capture_lost_reported = False

            ts_ms = int(now * 1000)
            with _STATE.lock:
                _STATE.pcm_seq += 1
                seq = _STATE.pcm_seq
                silence = bool(_STATE.features.get("silence"))
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
            if not self._bearer_ok():
                self._send_json({"ok": False, "error": "unauthorized"}, 401)
                return
            if path == "/healthz":
                self._send_json(self._healthz())
            elif path == "/api/state":
                self._send_json(self._state())
            elif path == "/api/presets":
                self._send_json({"presets": PRESETS, "default": DEFAULT_PRESET})
            elif path == "/api/config":
                self._send_json(self._config())
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
            if not self._bearer_ok():
                self._send_json({"ok": False, "error": "unauthorized"}, 401)
                return
            if path != "/api/control":
                self._send_json({"ok": False, "error": "not_found"}, 404)
                return
            try:
                data = self._body_json()
            except (ValueError, UnicodeDecodeError):
                self._send_json({"ok": False, "error": "bad_json"}, 400)
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
                "preset": cfg["preset"] or _STATE.preset,
            }
        return payload

    def _config(self) -> dict:
        cfg = config.load_config()
        return {
            "intensity": cfg["intensity"],
            "reduced_motion": cfg["reduced_motion"],
            "capture": _STATE.capture_name,
            "theme_opt_in": cfg["theme_opt_in"],
        }

    def _serve_index(self) -> None:
        index = Path(__file__).resolve().parent.parent / "web" / "index.html"
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
    return applied


def _apply_control(data) -> dict:
    applied = _validate_control(data)
    patch = {k: v for k, v in applied.items() if k in ("enabled", "intensity", "preset")}
    if patch:
        cfg = config.merge_config(patch)
        if "preset" in applied:
            with _STATE.lock:
                _STATE.preset = cfg["preset"]
        _broadcast_event(_config_event())
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
    """Create the socket, bind, and start serving + capture in daemon threads."""
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

    thread.start()
    cap_thread = threading.Thread(target=_capture_loop, args=(stop_event,),
                                  name="aura-capture", daemon=True)
    with _STATE.lock:
        _STATE.capture_thread = cap_thread
    cap_thread.start()
    _log("aura: listening on 127.0.0.1:%d", port)


# ---------------------------------------------------------------------------
# public internal API (CONTRACT §7) — all swallow-and-log
# ---------------------------------------------------------------------------

def ensure_server() -> None:
    """Start the server in a daemon thread if it is not running. Idempotent."""
    try:
        with _STATE.lock:
            running = (_STATE.httpd is not None and _STATE.thread is not None
                       and _STATE.thread.is_alive())
        if running:
            return
        _start_server()
    except Exception as exc:  # noqa: BLE001 - never block register()/a hook
        _log("aura: server start failed (%s)", type(exc).__name__)


def get_port() -> int | None:
    """Live port, or ``None`` when the server has not started."""
    try:
        with _STATE.lock:
            if _STATE.httpd is None:
                return None
            return _STATE.port
    except Exception:  # noqa: BLE001
        return None


def get_token() -> str | None:
    """The in-process token (for the port-discovery door). Never log it raw."""
    try:
        with _STATE.lock:
            return _STATE.token
    except Exception:  # noqa: BLE001
        return None


def get_capture() -> str:
    try:
        with _STATE.lock:
            return _STATE.capture_name
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


def publish_config() -> None:
    """Push the current config to connected pages (after a control change)."""
    try:
        if _clients_snapshot():
            _broadcast_event(_config_event())
    except Exception as exc:  # noqa: BLE001
        _log("aura: publish_config failed (%s)", type(exc).__name__)


def stop_server() -> None:
    """Clean shutdown: close sockets, join threads, leave no listener."""
    try:
        with _STATE.lock:
            httpd = _STATE.httpd
            thread = _STATE.thread
            cap_thread = _STATE.capture_thread
            stop_event = _STATE.stop_event
            clients = list(_STATE.clients)
            _STATE.httpd = None
            _STATE.thread = None
            _STATE.port = None
            _STATE.capture_thread = None
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
        with _STATE.lock:
            _STATE.clients.clear()
            _STATE.token = None
            _STATE.capture_name = "none"
            _STATE.features = analysis.silence_features()
            _STATE.mood = "idle"
            _STATE.mood_expiry = None
        _log("aura: server stopped")
    except Exception as exc:  # noqa: BLE001
        _log("aura: stop_server failed (%s)", type(exc).__name__)
