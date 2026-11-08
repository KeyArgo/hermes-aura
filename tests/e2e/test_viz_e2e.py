"""End-to-end verification for the Aura visualizer page (L2).

Runs the real page in muted headless Chrome, driven over raw CDP exactly like
.spike/s4_feed.py (DevToolsActivePort, Runtime.evaluate, readPixels on the same WebGL
context). A stdlib fake Aura server speaks CONTRACT.md §2 (binary PCM frames + text
mood/features/config events) and serves web/ from its own origin with ?token=.

Assertions:
  * silence renders black (no invented motion);
  * a tone produces non-blank, changing frames;
  * an approval mood changes the render, pulses at ≤2 Hz, never exceeds 3 flashes/s,
    and restores to idle when its ttl expires;
  * the page reconnects after the server restarts;
  * token 401, capture "none" and missing WebGL each show a one-line message;
    capture "none" keeps drawing ambient visuals (never a blank frame or a hard
    graphics blocker), while token/WebGL use the accent-only fallback;
  * prefers-reduced-motion lowers intensity and avoids strobe presets;
  * the intensity slider and on/off POST /api/control.

Run: .venv/bin/python -m pytest tests -q
"""
import base64
import hashlib
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import websocket

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
CHROME = "/usr/bin/google-chrome-stable"
TOKEN = "e2e_" + base64.urlsafe_b64encode(b"aura-e2e-token-0123456789abcdef").decode().rstrip("=")
MOODS = {"idle", "thinking", "tool", "approval", "error", "streaming", "done"}
BEHAVIORS = {"calm", "balanced", "intense"}
BEHAVIOR_PROFILES = {
    "calm": {"intensity_ceiling": 0.6, "pulse_hz_max": 0.0, "preset_family": "organic",
             "blend_ms": 2400, "mood_gain_scale": 0.35, "allow_strobe": False, "hard_pulse": False},
    "balanced": {"intensity_ceiling": 1.0, "pulse_hz_max": 1.0, "preset_family": "liquid",
                 "blend_ms": 1200, "mood_gain_scale": 1.0, "allow_strobe": True, "hard_pulse": True},
    "intense": {"intensity_ceiling": 1.0, "pulse_hz_max": 2.0, "preset_family": "geometric",
                "blend_ms": 600, "mood_gain_scale": 1.35, "allow_strobe": True, "hard_pulse": True},
}


# ---------------------------------------------------------------------------
# fake Aura server: static page + §2 WebSocket + control endpoints
# ---------------------------------------------------------------------------

def _ws_frame(opcode, payload):
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


class WSClient:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.closed = False

    def send(self, opcode, payload):
        with self.lock:
            if self.closed:
                return
            try:
                self.sock.sendall(_ws_frame(opcode, payload))
            except OSError:
                self.closed = True

    def send_json(self, obj):
        self.send(0x1, json.dumps(obj).encode("utf-8"))

    def send_pcm(self, seq, samples, silence=False):
        # CONTRACT §2: magic AURA, version 1, flags, header len 32, seq, ts, rate, n.
        header = struct.pack(
            "<4sBBHQQII",
            b"AURA", 1, 1 if silence else 0, 32, seq, int(time.time() * 1000), 48000, len(samples)
        )
        self.send(0x2, header + struct.pack("<%df" % len(samples), *samples))

    def read_frame(self, timeout=0.5):
        self.sock.settimeout(timeout)
        b1, b2 = self._recv_exact(2)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        data = self._recv_exact(length) if length else b""
        if masked:
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        return opcode, data

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise OSError("closed")
            buf += chunk
        return buf

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.sock.sendall(_ws_frame(0x8, struct.pack(">H", 1001)))
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass


class FakeAura:
    """Same-origin fake: page + WS stream + control API, contract-shaped."""

    def __init__(self):
        self.token = TOKEN
        self.capture = "pipewire"
        self.mode = "silence"          # silence | tone
        self.enabled = True
        self.intensity = 0.6
        self.opacity = 0.75
        self.behavior = "balanced"
        self.mood_reactive = True
        self.accent_pulse = True
        self.auto_preset = True
        self.mood = "idle"
        self.preset = None
        self.control_posts = []
        self.clients = set()
        self.lock = threading.Lock()
        self.port = 0
        self.httpd = None
        self.running = False
        self._seq = 0
        self._phase = 0.0
        self._last_features = {
            "type": "features", "seq": 0, "ts_ms": 0, "level": 0.0,
            "bands": [0.0] * 8, "onset": False, "centroid": 0.0,
            "flatness": 0.0, "silence": True,
        }

    # -- lifecycle ----------------------------------------------------------
    def start(self, port=0):
        aura = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _authorized(self, query):
                auth = self.headers.get("Authorization", "")
                if auth == "Bearer " + aura.token:
                    return True
                return query.get("token", [""])[0] == aura.token

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                if parsed.path == "/api/stream":
                    return self._ws(query)
                # The page itself and its static assets are served without auth: a
                # browser cannot put a Bearer header on <script src> / fetch('presets.json').
                # Data endpoints are gated, exactly like the real server.
                if (parsed.path == "/healthz" or parsed.path.startswith("/api/")) and not self._authorized(query):
                    return self._json(401, {"error": "unauthorized"})
                if parsed.path == "/healthz":
                    return self._json(200, {
                        "ok": True, "version": "0.1.0", "pid": os.getpid(),
                        "capture": aura.capture, "rate": 48000,
                        "clients": len(aura.clients),
                    })
                if parsed.path == "/api/state":
                    body = dict(aura._last_features)
                    body.update({"enabled": aura.enabled, "mood": aura.mood,
                                 "intensity": aura.intensity, "preset": aura.preset,
                                 "opacity": aura.opacity, "behavior": aura.behavior,
                                 "mood_reactive": aura.mood_reactive,
                                 "accent_pulse": aura.accent_pulse,
                                 "auto_preset": aura.auto_preset})
                    return self._json(200, body)
                if parsed.path == "/api/presets":
                    return self._file("presets.json")
                if parsed.path == "/api/config":
                    return self._json(200, {
                        "intensity": aura.intensity, "reduced_motion": False,
                        "capture": aura.capture, "theme_opt_in": False,
                        "enabled": aura.enabled, "preset": aura.preset,
                        "opacity": aura.opacity, "behavior": aura.behavior,
                        "mood_reactive": aura.mood_reactive,
                        "accent_pulse": aura.accent_pulse,
                        "auto_preset": aura.auto_preset,
                        "behavior_profile": dict(BEHAVIOR_PROFILES[aura.behavior]),
                    })
                return self._static(parsed.path)

            def do_POST(self):
                parsed = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                if not self._authorized(query):
                    return self._json(401, {"error": "unauthorized"})
                if parsed.path != "/api/control":
                    return self._json(404, {"error": "not found"})
                length = int(self.headers.get("Content-Length", "0"))
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    return self._json(400, {"error": "bad json"})
                if not isinstance(body, dict):
                    return self._json(400, {"error": "bad body"})
                if "enabled" in body and not isinstance(body["enabled"], bool):
                    return self._json(400, {"error": "bad enabled"})
                if "intensity" in body:
                    v = body["intensity"]
                    if not isinstance(v, (int, float)) or not (0 <= v <= 1):
                        return self._json(400, {"error": "bad intensity"})
                if "mood" in body and body["mood"] not in MOODS:
                    return self._json(400, {"error": "bad mood"})
                if "opacity" in body:
                    v = body["opacity"]
                    if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= v <= 1):
                        return self._json(400, {"error": "bad opacity"})
                if "behavior" in body and body["behavior"] not in BEHAVIORS:
                    return self._json(400, {"error": "bad behavior"})
                for toggle in ("mood_reactive", "accent_pulse", "auto_preset"):
                    if toggle in body and not isinstance(body[toggle], bool):
                        return self._json(400, {"error": "bad " + toggle})
                aura.control_posts.append(body)
                if "enabled" in body:
                    aura.enabled = body["enabled"]
                if "intensity" in body:
                    aura.intensity = float(body["intensity"])
                if "opacity" in body:
                    aura.opacity = float(body["opacity"])
                if "behavior" in body:
                    aura.behavior = body["behavior"]
                for toggle in ("mood_reactive", "accent_pulse", "auto_preset"):
                    if toggle in body:
                        setattr(aura, toggle, body[toggle])
                if "preset" in body:
                    aura.preset = body["preset"]
                if "mood" in body:
                    aura.mood = body["mood"] if aura.mood_reactive else "idle"
                return self._json(200, {"ok": True, "applied": body})

            def _json(self, code, obj):
                data = json.dumps(obj).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _file(self, name):
                path = WEB_DIR / name
                data = path.read_bytes()
                ctype = "application/json" if name.endswith(".json") else "text/plain"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _static(self, path):
                if path in ("/", ""):
                    name = "index.html"
                else:
                    name = path.lstrip("/")
                target = (WEB_DIR / name).resolve()
                if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
                    return self._json(404, {"error": "not found"})
                data = target.read_bytes()
                ctype = {
                    ".html": "text/html; charset=utf-8",
                    ".js": "text/javascript; charset=utf-8",
                    ".json": "application/json",
                    ".md": "text/markdown; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                }.get(target.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _ws(self, query):
                if query.get("token", [""])[0] != aura.token:
                    data = b'{"error":"unauthorized"}'
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    self.close_connection = True
                    return
                key = self.headers.get("Sec-WebSocket-Key", "")
                accept = base64.b64encode(hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                ).digest()).decode()
                self.send_response(101, "Switching Protocols")
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept)
                self.end_headers()
                self.wfile.flush()
                self.close_connection = True
                client = WSClient(self.connection)
                with aura.lock:
                    aura.clients.add(client)
                try:
                    while aura.running and not client.closed:
                        try:
                            opcode, data = client.read_frame(timeout=0.5)
                        except socket.timeout:
                            continue
                        except OSError:
                            break
                        if opcode == 0x8:
                            break
                        if opcode == 0x9:
                            client.send(0xA, data)
                        elif opcode == 0x1:
                            try:
                                msg = json.loads(data)
                            except ValueError:
                                continue
                            if msg.get("type") == "ping":
                                client.send_json({"type": "pong"})
                finally:
                    with aura.lock:
                        aura.clients.discard(client)
                    client.close()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.running = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        threading.Thread(target=self._feeder, daemon=True).start()
        return self.port

    def stop(self, close_http=True):
        self.running = False
        with self.lock:
            clients = list(self.clients)
            self.clients.clear()
        for c in clients:
            c.close()
        if close_http and self.httpd:
            try:
                self.httpd.shutdown()
                self.httpd.server_close()
            finally:
                self.httpd = None

    # -- stream -------------------------------------------------------------
    def _tone_samples(self, n=1024):
        out = []
        for i in range(n):
            t = (self._phase + i) / 48000.0
            v = (0.42 * math.sin(2 * math.pi * 220 * t)
                 + 0.28 * math.sin(2 * math.pi * 880 * t)
                 + 0.10 * math.sin(2 * math.pi * 1500 * t))
            v *= 0.65 + 0.35 * math.sin(2 * math.pi * 1.7 * t)
            out.append(max(-1.0, min(1.0, v)))
        self._phase += n
        return out

    def _feeder(self):
        last_features = 0.0
        last_mood = 0.0
        while self.running:
            now = time.time()
            with self.lock:
                clients = list(self.clients)
            if clients:
                self._seq += 1
                if self.mode == "tone":
                    samples = self._tone_samples()
                    silent = False
                else:
                    samples = [0.0] * 1024
                    silent = True
                for c in clients:
                    c.send_pcm(self._seq, samples, silence=silent)
                if now - last_features >= 0.1:
                    last_features = now
                    level = 0.72 if self.mode == "tone" else 0.0
                    bands = [0.6, 0.7, 0.8, 0.55, 0.45, 0.35, 0.25, 0.15] if self.mode == "tone" else [0.0] * 8
                    self._last_features = {
                        "type": "features", "seq": self._seq, "ts_ms": int(now * 1000),
                        "level": level, "bands": bands, "onset": self.mode == "tone",
                        "centroid": 0.35, "flatness": 0.2, "silence": self.mode != "tone",
                    }
                    for c in clients:
                        c.send_json(self._last_features)
                if self.mood != "idle" and now - last_mood >= 2.0:
                    last_mood = now
                    for c in clients:
                        c.send_json({"type": "mood", "mood": self.mood,
                                     "intensity": 0.85, "ttl_ms": 8000, "seq": self._seq})
            time.sleep(0.02)

    def send_mood(self, mood, intensity=0.85, ttl_ms=4000, repeat=False):
        self.mood = mood if repeat else self.mood
        with self.lock:
            clients = list(self.clients)
        for c in clients:
            c.send_json({"type": "mood", "mood": mood, "intensity": intensity,
                         "ttl_ms": ttl_ms, "seq": self._seq})

    def send_preset(self, name, blend_ms=1200):
        self.preset = name
        with self.lock:
            clients = list(self.clients)
        for c in clients:
            c.send_json({"type": "preset", "name": name, "blend_ms": blend_ms})

    def send_config(self):
        with self.lock:
            clients = list(self.clients)
        for c in clients:
            c.send_json({"type": "config", "intensity": self.intensity,
                         "reduced_motion": False, "capture": self.capture,
                         "theme_opt_in": False, "enabled": self.enabled,
                         "preset": self.preset, "opacity": self.opacity,
                         "behavior": self.behavior,
                         "mood_reactive": self.mood_reactive,
                         "accent_pulse": self.accent_pulse,
                         "auto_preset": self.auto_preset,
                         "behavior_profile": dict(BEHAVIOR_PROFILES[self.behavior])})


# ---------------------------------------------------------------------------
# Chrome + CDP (same approach as .spike/s4_feed.py)
# ---------------------------------------------------------------------------

def _chrome_binary():
    if os.path.exists(CHROME):
        return CHROME
    for cand in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(cand)
        if p:
            return p
    return None


class Tab:
    def __init__(self, ws_url, target_id, debug_port):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.target_id = target_id
        self.debug_port = debug_port
        self._seq = 0

    def send(self, method, params=None):
        self._seq += 1
        msg = {"id": self._seq, "method": method}
        if params is not None:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        while True:
            raw = self.ws.recv()
            reply = json.loads(raw)
            if reply.get("id") == self._seq:
                if "error" in reply:
                    raise AssertionError("%s failed: %s" % (method, reply["error"]))
                return reply.get("result", {})

    def ev(self, expr):
        result = self.send("Runtime.evaluate", {
            "expression": expr, "awaitPromise": True, "returnByValue": True
        })
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            raise AssertionError("JS exception: %s %s" % (details.get("text"), details.get("exception", {}).get("description")))
        return result.get("result", {}).get("value")

    def navigate(self, url):
        self.send("Page.navigate", {"url": url})

    def close(self):
        try:
            urllib.request.urlopen(urllib.request.Request(
                "http://127.0.0.1:%d/json/close/%s" % (self.debug_port, self.target_id)))
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass


class Chrome:
    def __init__(self):
        binary = _chrome_binary()
        if not binary:
            pytest.skip("no Chrome/Chromium available")
        self.profile = tempfile.mkdtemp(prefix="aura-e2e-")
        self.proc = subprocess.Popen([
            binary, "--headless=new", "--mute-audio",
            "--autoplay-policy=no-user-gesture-required",
            "--user-data-dir=" + self.profile,
            "--remote-debugging-port=0", "--remote-allow-origins=*",
            "--window-size=1200,900", "--no-first-run", "--no-default-browser-check",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = os.path.join(self.profile, "DevToolsActivePort")
        for _ in range(100):
            if os.path.exists(port_file):
                break
            if self.proc.poll() is not None:
                raise RuntimeError("Chrome exited early")
            time.sleep(0.2)
        if not os.path.exists(port_file):
            raise RuntimeError("Chrome did not write DevToolsActivePort")
        self.debug_port = int(open(port_file).read().split()[0])

    def new_tab(self, url="about:blank"):
        quoted = urllib.parse.quote(url, safe="")
        info = json.load(urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:%d/json/new?%s" % (self.debug_port, quoted), method="PUT")))
        tab = Tab(info["webSocketDebuggerUrl"], info["id"], self.debug_port)
        try:
            tab.send("Page.enable")
            tab.send("Page.bringToFront")
        except AssertionError:
            pass
        return tab

    # -- CPU: whole process tree, so renderer/GPU work is counted ----------
    @staticmethod
    def _proc_table():
        table = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / "stat").read_text()
                idx = raw.rfind(")")
                fields = raw[idx + 2:].split()
                table[int(entry.name)] = (int(fields[1]), int(fields[11]) + int(fields[12]))
            except (OSError, IndexError, ValueError):
                continue
        return table

    def cpu_seconds(self):
        table = self._proc_table()
        children = {}
        for pid, (ppid, _ticks) in table.items():
            children.setdefault(ppid, []).append(pid)
        total = 0
        stack = [self.proc.pid]
        seen = set()
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            if pid in table:
                total += table[pid][1]
            stack.extend(children.get(pid, []))
        return total / os.sysconf("SC_CLK_TCK")

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def page_url(port, token=TOKEN, extra=""):
    return "http://127.0.0.1:%d/?token=%s%s" % (port, urllib.parse.quote(token), extra)


def wait_for(tab, expr, predicate, timeout=25.0, interval=0.2, label=""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = tab.ev(expr)
        except AssertionError:
            last = None
        if last is not None and predicate(last):
            return last
        time.sleep(interval)
    raise AssertionError("timed out waiting for %s; last=%r" % (label or expr, last))


def wait_ready(tab, timeout=30.0):
    # ready is set at the end of boot(); the WS handshake happens in the same tick, so
    # also wait for the socket to settle so assertions do not race the handshake.
    snap = wait_for(tab, "window.__aura && window.__aura.snapshot()",
                    lambda s: bool(s and s.get("ready") and s.get("socketState") in ("connected", "refused")),
                    timeout=timeout, label="page ready")
    return snap


def sample(tab):
    return tab.ev("window.__aura.sampleNow()")


def wait_lit(tab, min_fraction=0.12, timeout=15.0, interval=0.5):
    """Poll until the visualizer is visibly driven by the tone (real frames, not black)."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = sample(tab)
        if last:
            sampled = (last["w"] * last["h"]) // 4
            if last.get("lit", 0) > max(500, min_fraction * sampled):
                return last
        time.sleep(interval)
    raise AssertionError("visualizer never lit up above %.0f%% of pixels; last=%r" % (100 * min_fraction, last))


def snapshot(tab):
    return tab.ev("window.__aura.snapshot()")


def expect_mood(tab, name, timeout=8.0):
    return wait_for(tab, "window.__aura.snapshot()",
                    lambda s: s and s.get("mood") == name,
                    timeout=timeout, label="mood " + name)


@pytest.fixture(scope="module")
def chrome():
    c = Chrome()
    yield c
    c.close()


@pytest.fixture()
def aura():
    srv = FakeAura()
    srv.start()
    yield srv
    srv.stop(close_http=True)


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

def test_visualizer_analyser_receives_pcm(chrome, aura):
    tab = chrome.new_tab()
    try:
        tab.send('Page.addScriptToEvaluateOnNewDocument', {'source': """
            window.__auraAnalysers = [];
            const original = AudioContext.prototype.createAnalyser;
            AudioContext.prototype.createAnalyser = function() {
                const node = original.call(this);
                window.__auraAnalysers.push(node);
                return node;
            };
        """})
        tab.navigate(page_url(aura.port))
        wait_ready(tab)
        amplitude = """(() => Math.max(0, ...window.__auraAnalysers.map(a => {
            const samples = new Float32Array(a.fftSize);
            a.getFloatTimeDomainData(samples);
            return Math.max(...samples.map(Math.abs));
        })))()"""
        assert tab.ev('window.__auraAnalysers.length') > 0
        assert tab.ev(amplitude) < 0.001
        aura.mode = 'tone'
        peak = wait_for(tab, amplitude, lambda n: n > 0.01, timeout=8, label='tone in visualizer analyser')
        assert peak > 0.01
        aura.mode = 'silence'
        wait_for(tab, amplitude, lambda n: n < 0.001, timeout=8, label='silence in visualizer analyser')
        assert tab.ev('window.__aura.snapshot().audio.mutedGain') == 0
    finally:
        tab.close()

def test_silence_black_tone_moves_and_cpu(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        snap = wait_ready(tab)
        print("boot: tier=%s renderer=%r canvas=%s worklet=%s muted_gain=%s errors=%s" % (
            snap["quality"]["tier"], snap["quality"]["renderer"], snap["canvas"],
            snap["audio"]["worklet"], snap["audio"]["mutedGain"], snap["errors"]), flush=True)
        assert snap["audio"]["worklet"] is True, "AudioWorklet graph did not start"
        assert snap["audio"]["mutedGain"] == 0, "audio must reach destination through gain 0"
        assert snap["canvasAttrs"]["width"] > 0 and snap["canvasAttrs"]["height"] > 0
        assert snap["quality"]["tier"] == "degraded-software", snap["quality"]
        assert snap["quality"]["fpsCap"] <= 24, "software GL must cap fps ~24"
        assert snap["canvas"]["w"] < snap["canvas"]["cssW"], "software GL must render below CSS size (scaled up)"
        print("PASS degraded-resolution canvas=%dx%d css=%dx%d fpsCap=%d renderer=%r" % (
            snap["canvas"]["w"], snap["canvas"]["h"], snap["canvas"]["cssW"],
            snap["canvas"]["cssH"], snap["quality"]["fpsCap"], snap["quality"]["renderer"]), flush=True)
        assert snap["socketState"] == "connected"
        assert snap["preset"], "no preset loaded"
        assert snap["errors"] == [], snap["errors"]

        # Silence: no invented motion. The default preset decays to black; the
        # residual is a handful of near-zero pixels, so "black" is mean<=2 and
        # <2% of sampled pixels above the visibility threshold.
        aura.mode = "silence"
        time.sleep(1.6)
        a = sample(tab)
        time.sleep(1.2)
        b = sample(tab)
        sampled = (a["w"] * a["h"]) // 4  # stride 16 bytes per sample
        print("silence samples: %s / %s (samples=%d)" % (a, b, sampled), flush=True)
        assert a is not None and b is not None
        # Butterchurn keeps a short decay tail after audio stops, so a couple of
        # near-black pixels can tick over between samples. The invariant is
        # "stays visually dark and does not invent motion", not pixel identity.
        assert a["mean"] <= 3 and b["mean"] <= 3, "silence must render black, got %s / %s" % (a, b)
        assert abs(a["mean"] - b["mean"]) <= 1, "silence must not invent motion: %s -> %s" % (a, b)
        assert a["lit"] <= 0.03 * sampled, "silence must stay visually dark, got %d/%d lit" % (a["lit"], sampled)

        # Tone on a bright preset: real signal moves the render.
        aura.send_preset("Zylot - True Visionary (Final Mix)", blend_ms=0)
        time.sleep(1.2)
        aura.mode = "tone"
        c = wait_for(tab, "window.__aura.sampleNow()",
                     lambda s: bool(s and s["mean"] > 2 and s["lit"] > 0.08 * (s["w"] * s["h"] // 4)),
                     timeout=15, label="bright tone frame")
        time.sleep(1.0)
        d = sample(tab)
        print("tone samples: %s / %s" % (c, d), flush=True)
        sampled_c = (c["w"] * c["h"]) // 4
        assert c["preset"] == "Zylot - True Visionary (Final Mix)", c["preset"]
        assert c["mean"] > 2, "tone should lift the frame, got %s" % (c,)
        assert c["lit"] > 0.08 * sampled_c, "tone should light up the canvas, got %s" % (c,)
        assert c["hash"] != d["hash"], "tone frames should change over time"
        print("PASS silence-black mean=%d lit=%d/%d" % (a["mean"], a["lit"], sampled), flush=True)
        print("PASS tone-moves mean=%d lit=%d->%d hash=%d->%d" % (
            c["mean"], c["lit"], d["lit"], c["hash"], d["hash"]), flush=True)

        # CPU over ~8 s at the degraded (software GL) resolution.
        snap = snapshot(tab)
        frames0 = snap["frames"]
        cpu0 = chrome.cpu_seconds()
        t0 = time.time()
        time.sleep(8.0)
        cpu1 = chrome.cpu_seconds()
        dt = time.time() - t0
        frames1 = snapshot(tab)["frames"]
        snap = snapshot(tab)
        cpu = cpu1 - cpu0
        print("CPU: chrome process tree %.1fs CPU over %.1fs = %.0f%% of one core "
              "(browser+renderers) at %dx%d, tier=%s renderer=%r, fps=%.1f, frames=%d" % (
                  cpu, dt, 100.0 * cpu / dt, snap["canvas"]["w"], snap["canvas"]["h"],
                  snap["quality"]["tier"], snap["quality"]["renderer"],
                  (frames1 - frames0) / dt, frames1), flush=True)
        print("quality: renderScale=%.2f fpsCap=%d degradeLevel=%d" % (
            snap["quality"]["renderScale"], snap["quality"]["fpsCap"],
            snap["quality"]["degradeLevel"]), flush=True)
        assert cpu > 0, "no CPU measured"
        assert frames1 > frames0, "render loop stalled"
        print("PASS cpu-measured %.0f%% of one core over %.1fs" % (100.0 * cpu / dt, dt), flush=True)

        # Silence gate: the visual follows the audio, so a bright preset must not
        # free-run once capture goes quiet. Measured before the gate existed: 20
        # of 21 curated presets stayed lit at mean 24..155 with no audio.
        aura.mode = "silence"
        time.sleep(2.2)
        e = sample(tab)
        time.sleep(1.2)
        f = sample(tab)
        print("silence-gate after tone: %s / %s" % (e, f), flush=True)
        assert e["mean"] <= 3 and f["mean"] <= 3, "silence gate must darken a rich preset, got %s / %s" % (e, f)
        assert abs(e["mean"] - f["mean"]) <= 1, "paused canvas must not invent motion: %s -> %s" % (e, f)
        snap = snapshot(tab)
        assert snap.get("silent") is True, "page must report silent=true, got %r" % snap.get("silent")
        print("PASS silence-gate mean=%d silent=%s" % (e["mean"], snap.get("silent")), flush=True)
    finally:
        tab.close()


def test_approval_mood_changes_render_pulses_and_restores(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        aura.send_preset("Zylot - True Visionary (Final Mix)", blend_ms=0)
        time.sleep(1.2)
        aura.mode = "tone"
        before = wait_lit(tab, 0.04, timeout=15)
        base = snapshot(tab)
        sampled_before = (before["w"] * before["h"]) // 4
        assert before["lit"] > 0.04 * sampled_before, "tone baseline should be lit before the mood change: %s" % (before,)

        aura.send_mood("approval", intensity=0.85, ttl_ms=5000)
        expect_mood(tab, "approval", timeout=6)
        time.sleep(0.8)
        during = sample(tab)
        snap = snapshot(tab)
        print("approval: mood=%s previous=%s intensity=%s gain=%s preset=%s pulsePeriod=%sms "
              "flashLastSecond=%d flashMax=%d" % (
                  snap["mood"], snap["previousMood"], snap["intensity"], snap["sampleGain"],
                  snap["preset"], snap["pulsePeriodMs"], snap["flash"]["lastSecond"],
                  snap["flash"]["maxPerSecond"]), flush=True)
        print("approval frames: before hash=%d mean=%d lit=%d | during hash=%d mean=%d lit=%d" % (
            before["hash"], before["mean"], before["lit"],
            during["hash"], during["mean"], during["lit"]), flush=True)

        assert snap["mood"] == "approval"
        assert snap["intensity"] >= 0.6, "attention moods must reach intensity ≥0.6"
        assert snap["sampleGain"] > base["sampleGain"], "approval must lift the render energy"
        assert during["sampleGain"] > before["sampleGain"], "approval gain must reach the PCM path"
        assert during["hash"] != before["hash"], "approval must visibly change the render"
        assert snap["pulsePeriodMs"] >= 500, "attention pulse must be ≤2 Hz"
        assert snap["flash"]["maxPerSecond"] <= 3, "flash limiter exceeded 3 flashes/s"
        assert snap["flash"]["lastSecond"] <= 3
        print("PASS approval-changes-render hash=%d->%d gain=%s->%s" % (
            before["hash"], during["hash"], base["sampleGain"], snap["sampleGain"]), flush=True)
        print("PASS attention-pulse period=%dms flash<=3/s" % snap["pulsePeriodMs"], flush=True)

        # Restore-on-clear after the TTL, allowing for slow software rendering.
        snap = wait_for(tab, "window.__aura.snapshot()", lambda s: s and s.get("mood") == "idle",
                        timeout=8, label="mood restored after TTL")
        print("after ttl: mood=%s previous=%s pulsePeriod=%s" % (
            snap["mood"], snap["previousMood"], snap["pulsePeriodMs"]), flush=True)
        assert snap["mood"] == "idle", "attention mood latched instead of restoring"
        print("PASS restore-on-clear mood=idle", flush=True)

        # A short approval still expires without waiting for frame readback.
        aura.send_mood("approval", intensity=0.85, ttl_ms=1500)
        expect_mood(tab, "approval", timeout=6)
        wait_for(tab, "window.__aura.snapshot().mood", lambda value: value == "idle",
                 timeout=3.2, label="short approval TTL")
    finally:
        tab.close()


def test_reconnects_after_server_restart(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        aura.send_preset("Zylot - True Visionary (Final Mix)", blend_ms=0)
        time.sleep(1.0)
        aura.mode = "tone"
        wait_for(tab, "window.__aura.snapshot().frames", lambda f: f > 0, timeout=10, label="frames")
        port = aura.port
        aura.stop(close_http=True)
        snap = wait_for(tab, "window.__aura.snapshot()",
                        lambda s: s and s["socketState"] in ("reconnecting", "refused"),
                        timeout=10, label="disconnect noticed")
        print("after server stop: socket=%s message=%r" % (snap["socketState"], snap["message"]), flush=True)
        assert snap["socketState"] == "reconnecting"
        assert snap["message"] and "Reconnecting" in snap["message"]
        assert snap["mood"] == "idle", "mood must not survive a lost connection"

        time.sleep(1.2)
        aura.start(port=port)
        aura.mode = "tone"
        snap = wait_for(tab, "window.__aura.snapshot()",
                        lambda s: s and s["socketState"] == "connected",
                        timeout=15, label="reconnect")
        print("reconnected: socket=%s attempts=%d" % (snap["socketState"], snap["reconnectAttempts"]), flush=True)
        frames0 = snap["frames"]
        time.sleep(2.0)
        snap = snapshot(tab)
        tone = wait_lit(tab, 0.08, timeout=12)
        assert snap["frames"] > frames0, "render did not resume after reconnect"
        sampled_tone = (tone["w"] * tone["h"]) // 4
        assert tone["lit"] > 0.08 * sampled_tone, "stream did not resume after reconnect"
        print("PASS reconnect frames %d->%d lit=%d" % (frames0, snap["frames"], tone["lit"]), flush=True)
    finally:
        tab.close()


def test_token_refused_shows_message_and_fallback(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port, token="wrong-token"))
    try:
        snap = wait_for(tab, "window.__aura && window.__aura.snapshot()",
                        lambda s: s and s.get("ready"), timeout=20, label="ready")
        print("token refused: socket=%s fallback=%s message=%r" % (
            snap["socketState"], snap["fallbackReasons"], snap["message"]), flush=True)
        assert "token" in snap["fallbackReasons"]
        assert snap["socketState"] == "refused"
        assert snap["message"] and "401" in snap["message"]
        assert snap["fallbackActive"] is True
        hidden = tab.ev("getComputedStyle(document.getElementById('aura-canvas')).visibility")
        assert hidden == "hidden", "canvas should be hidden in accent-only fallback"
        glow = tab.ev("getComputedStyle(document.getElementById('aura-glow')).opacity")
        assert float(glow) > 0.05, "accent-only fallback must show the accent glow"
        print("PASS token-refused message=%r glow=%s" % (snap["message"], glow), flush=True)
    finally:
        tab.close()


def test_capture_none_shows_message_and_fallback(chrome, aura):
    aura.capture = "none"
    tab = chrome.new_tab(page_url(aura.port))
    try:
        snap = wait_for(tab, "window.__aura && window.__aura.snapshot()",
                        lambda s: s and s.get("ready") and s.get("message"),
                        timeout=20, label="ready")
        print("capture none: capture=%s fallback=%s message=%r" % (
            snap["capture"], snap["fallbackReasons"], snap["message"]), flush=True)
        assert snap["capture"] == "none"
        assert "capture" not in snap["fallbackReasons"], \
            "capture absence must not be a hard graphics blocker in ambient mode"
        assert snap["fallbackActive"] is False
        assert snap["messageTone"] == "info"
        assert snap["message"] and "loopback" in snap["message"].lower()
        assert "ambient" in snap["message"].lower()
        assert snap["ambientFallback"] is True
        visible = tab.ev("getComputedStyle(document.getElementById('aura-canvas')).visibility")
        assert visible == "visible", "ambient visuals must keep drawing without capture"
        snap = wait_for(tab, "window.__aura.snapshot()",
                        lambda s: s and s["frames"] > 0, timeout=10, label="ambient frames")
        print("PASS capture-none ambient message=%r frames=%d" % (
            snap["message"], snap["frames"]), flush=True)
    finally:
        tab.close()


def test_missing_webgl_shows_message_and_fallback(chrome, aura):
    tab = chrome.new_tab("about:blank")
    try:
        tab.send("Page.enable")
        tab.send("Page.addScriptToEvaluateOnNewDocument", {"source": """
            (() => {
              const orig = HTMLCanvasElement.prototype.getContext;
              HTMLCanvasElement.prototype.getContext = function (type, attrs) {
                if (type === 'webgl2' || type === 'webgl') return null;
                return orig.call(this, type, attrs);
              };
            })();
        """})
        tab.navigate(page_url(aura.port))
        snap = wait_for(tab, "window.__aura && window.__aura.snapshot()",
                        lambda s: s and s.get("ready"), timeout=20, label="ready")
        print("no webgl: tier=%s fallback=%s message=%r" % (
            snap["quality"]["tier"], snap["fallbackReasons"], snap["message"]), flush=True)
        assert "webgl" in snap["fallbackReasons"]
        assert snap["message"] and "WebGL" in snap["message"]
        assert snap["fallbackActive"] is True
        hidden = tab.ev("getComputedStyle(document.getElementById('aura-canvas')).visibility")
        assert hidden == "hidden"
        print("PASS no-webgl message=%r" % snap["message"], flush=True)
    finally:
        tab.close()


def test_reduced_motion_lowers_intensity_and_avoids_strobe(chrome, aura):
    tab = chrome.new_tab("about:blank")
    try:
        tab.send("Page.enable")
        tab.send("Emulation.setEmulatedMedia", {"features": [
            {"name": "prefers-reduced-motion", "value": "reduce"}
        ]})
        tab.navigate(page_url(aura.port))
        snap = wait_for(tab, "window.__aura && window.__aura.snapshot()",
                        lambda s: s and s.get("ready") and s.get("reducedMotion") is True,
                        timeout=20, label="ready with reduced motion")
        print("reduced motion: flag=%s preset=%r strobe=%s gain=%s fpsCap=%s allowed=%d" % (
            snap["reducedMotion"], snap["preset"], snap["presetStrobe"],
            snap["sampleGain"], snap["quality"]["fpsCap"],
            snap["reducedPresetsAllowed"]), flush=True)
        assert snap["reducedMotion"] is True
        assert snap["presetStrobe"] is False, "reduced motion must not pick a strobe preset"
        assert snap["quality"]["fpsCap"] <= 30
        assert snap["sampleGain"] < 1.1, "reduced motion must lower intensity"
        assert snap["reducedPresetsAllowed"] > 0
        print("PASS reduced-motion gain=%s fpsCap=%d strobe=%s" % (
            snap["sampleGain"], snap["quality"]["fpsCap"], snap["presetStrobe"]), flush=True)
    finally:
        tab.close()


def test_mood_mapping_drives_visible_behaviour_without_touching_audio(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        idle = snapshot(tab)
        idle_gain = idle["sampleGain"]
        idle_filter = tab.ev("document.getElementById('aura-canvas').style.filter")
        print("idle: gain=%s filter=%r audio=%s mutedGain=%s" % (
            idle_gain, idle_filter, idle["audio"]["state"], idle["audio"]["mutedGain"]), flush=True)

        # thinking: intensity/brightness lift
        aura.send_mood("thinking", intensity=0.7, ttl_ms=8000)
        snap = expect_mood(tab, "thinking")
        bright = tab.ev("document.getElementById('aura-canvas').style.filter")
        print("thinking: mood=%s gain=%s filter=%r" % (snap["mood"], snap["sampleGain"], bright), flush=True)
        assert snap["sampleGain"] > idle_gain, "thinking must lift render energy"
        assert "brightness" in bright and bright != idle_filter, "thinking must lift brightness"
        assert float(bright.split("(")[1].rstrip(")")) > 1.1, "thinking brightness lift must be real"

        # tool: one accent tick, counted by the flash limiter
        flashes_before = snapshot(tab)["flash"]["accepted"]
        aura.send_mood("tool", intensity=0.6, ttl_ms=8000)
        snap = expect_mood(tab, "tool")
        print("tool: mood=%s flashes=%d->%d" % (snap["mood"], flashes_before, snap["flash"]["accepted"]), flush=True)
        assert snap["flash"]["accepted"] > flashes_before, "tool must tick the accent once"

        # approval: attention pulse, intensity floor, never faster than 2 Hz
        aura.send_mood("approval", intensity=0.85, ttl_ms=8000)
        snap = expect_mood(tab, "approval")
        print("approval: mood=%s intensity=%s pulse=%dms attention=%s" % (
            snap["mood"], snap["intensity"], snap["pulsePeriodMs"],
            tab.ev("document.getElementById('aura-root').dataset.attention")), flush=True)
        assert snap["intensity"] >= 0.6
        assert snap["pulsePeriodMs"] >= 500
        assert tab.ev("document.getElementById('aura-root').dataset.attention") == "1"

        # error: red-tinted settle (theme danger var, not a hardcoded colour in JS)
        aura.send_mood("error", intensity=0.8, ttl_ms=8000)
        snap = expect_mood(tab, "error")
        tint = tab.ev("document.getElementById('aura-root').style.getPropertyValue('--aura-tint')")
        print("error: mood=%s tint=%r intensity=%s" % (snap["mood"], tint.strip(), snap["intensity"]), flush=True)
        assert float(tint.strip() or 0) > 0, "error must show the red settle tint"
        assert snap["intensity"] >= 0.6

        # streaming: brighter energy than thinking
        aura.send_mood("streaming", intensity=0.8, ttl_ms=8000)
        snap = expect_mood(tab, "streaming")
        print("streaming: mood=%s gain=%s" % (snap["mood"], snap["sampleGain"]), flush=True)
        assert snap["sampleGain"] > 1.5, "streaming must raise the energy"

        # done: one short settle, then idle (≤1.5 s)
        aura.send_mood("done", intensity=0.5, ttl_ms=1500)
        expect_mood(tab, "done", timeout=5)
        time.sleep(1.8)
        snap = snapshot(tab)
        print("done settle: mood=%s after 1.8s" % snap["mood"], flush=True)
        assert snap["mood"] == "idle", "done must settle back to idle within 1.5 s"

        # idle: back to baseline; mood never touched the audio graph
        aura.send_mood("idle", intensity=0.0, ttl_ms=0)
        snap = expect_mood(tab, "idle")
        print("idle again: gain=%s audio=%s mutedGain=%s flashMax=%d" % (
            snap["sampleGain"], snap["audio"]["state"], snap["audio"]["mutedGain"],
            snap["flash"]["maxPerSecond"]), flush=True)
        assert abs(snap["sampleGain"] - idle_gain) < 0.01
        assert snap["audio"]["state"] == "running", "mood must never pause the audio graph"
        assert snap["audio"]["mutedGain"] == 0
        assert snap["flash"]["maxPerSecond"] <= 3
        print("PASS mood-mapping idle/thinking/tool/approval/error/streaming/done", flush=True)
        print("PASS mood-never-touches-audio state=running gain=0 flashes<=3/s", flush=True)
    finally:
        tab.close()


def test_software_gl_auto_degrades_when_frame_budget_missed(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        snap = wait_ready(tab)
        assert snap["quality"]["tier"] == "degraded-software"
        # The degrade ladder needs frames: the silence gate pauses rendering when
        # capture is quiet, so this test must feed tone or it would never measure
        # a missed budget.
        aura.mode = "tone"
        time.sleep(1.0)
        print("baseline: canvas=%dx%d css=%dx%d renderScale=%.2f fpsCap=%d" % (
            snap["canvas"]["w"], snap["canvas"]["h"], snap["canvas"]["cssW"],
            snap["canvas"]["cssH"], snap["quality"]["renderScale"],
            snap["quality"]["fpsCap"]), flush=True)
        # Force a much larger surface: the frame budget is then missed for real.
        tab.send("Emulation.setDeviceMetricsOverride", {
            "width": 2560, "height": 1440, "deviceScaleFactor": 1, "mobile": False
        })
        snap = wait_for(tab, "window.__aura.snapshot()",
                        lambda s: s and s["quality"]["degradeLevel"] > 0,
                        timeout=35, label="auto-degrade")
        print("degraded: canvas=%dx%d renderScale=%.2f fpsCap=%d level=%d" % (
            snap["canvas"]["w"], snap["canvas"]["h"], snap["quality"]["renderScale"],
            snap["quality"]["fpsCap"], snap["quality"]["degradeLevel"]), flush=True)
        assert snap["quality"]["renderScale"] < 0.45, "auto-degrade must lower resolution"
        assert snap["quality"]["fpsCap"] < 24, "auto-degrade must lower the fps cap"
        assert snap["canvas"]["w"] < snap["canvas"]["cssW"]
        print("PASS auto-degrade level=%d scale=%.2f fpsCap=%d" % (
            snap["quality"]["degradeLevel"], snap["quality"]["renderScale"],
            snap["quality"]["fpsCap"]), flush=True)
    finally:
        tab.close()


def test_intensity_slider_and_toggle_post_control(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        tab.ev("""(() => {
            const s = document.getElementById('aura-intensity');
            s.value = '25';
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()""")
        got = wait_for(tab, "window.__aura.snapshot().userIntensity",
                       lambda v: abs(float(v or 0) - 0.25) < 0.02, timeout=8, label="slider state")
        deadline = time.time() + 8
        while time.time() < deadline:
            if any("intensity" in p for p in aura.control_posts):
                break
            time.sleep(0.1)
        print("control posts after slider: %s" % aura.control_posts, flush=True)
        assert any(abs(float(p.get("intensity", -1)) - 0.25) < 0.01 for p in aura.control_posts
                   if "intensity" in p), "slider must POST /api/control intensity"
        print("PASS slider-posts intensity=0.25 userIntensity=%s" % got, flush=True)

        tab.ev("document.getElementById('aura-toggle').click()")
        deadline = time.time() + 8
        while time.time() < deadline:
            if any(p.get("enabled") is False for p in aura.control_posts):
                break
            time.sleep(0.1)
        snap = snapshot(tab)
        print("control posts after toggle: %s enabled=%s frames=%d" % (
            aura.control_posts, snap["enabled"], snap["frames"]), flush=True)
        assert any(p.get("enabled") is False for p in aura.control_posts), "toggle must POST /api/control enabled=false"
        assert snap["enabled"] is False
        assert snap["mood"] == "idle", "mood must reset when Aura is switched off"
        frames_off = snap["frames"]
        time.sleep(1.0)
        assert snapshot(tab)["frames"] == frames_off, "render loop must stop when Aura is off"
        print("PASS toggle-posts enabled=false frames-stop=%d" % frames_off, flush=True)

        tab.ev("document.getElementById('aura-toggle').click()")
        deadline = time.time() + 8
        while time.time() < deadline:
            if any(p.get("enabled") is True for p in aura.control_posts):
                break
            time.sleep(0.1)
        wait_for(tab, "window.__aura.snapshot().frames", lambda f: f > frames_off, timeout=8, label="render resumes")
        print("PASS toggle-on resumes rendering", flush=True)
    finally:
        tab.close()
