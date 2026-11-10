#!/usr/bin/env python3
"""Local Aura server for freeze proof: serves this copy's web/ and streams a
synthetic 120 BPM kick loop as CONTRACT.md section 2 PCM frames.

Not a test server: it exists so a headless browser can run the real page for
minutes against deterministic audio.  No capture, no speakers.
"""
import argparse, base64, hashlib, json, math, os, socket, struct, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")


def ws_frame(opcode, payload):
    n = len(payload)
    h = bytearray([0x80 | opcode])
    if n < 126:
        h.append(n)
    elif n < 65536:
        h.append(126); h += struct.pack(">H", n)
    else:
        h.append(127); h += struct.pack(">Q", n)
    return bytes(h) + payload


class Client:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.closed = False
    def send(self, opcode, payload):
        with self.lock:
            if self.closed: return
            try: self.sock.sendall(ws_frame(opcode, payload))
            except OSError: self.closed = True
    def send_json(self, obj):
        self.send(0x1, json.dumps(obj).encode())
    def send_pcm(self, seq, samples, silent=False):
        header = struct.pack("<4sBBHQQII", b"AURA", 1, 1 if silent else 0, 32,
                             seq, int(time.time() * 1000), 48000, len(samples))
        self.send(0x2, header + struct.pack("<%df" % len(samples), *samples))
    def recv_frame(self, timeout=0.5):
        self.sock.settimeout(timeout)
        b1, b2 = self._exact(2)
        op = b1 & 0x0F; masked = bool(b2 & 0x80); n = b2 & 0x7F
        if n == 126: n = struct.unpack(">H", self._exact(2))[0]
        elif n == 127: n = struct.unpack(">Q", self._exact(8))[0]
        mask = self._exact(4) if masked else b""
        data = self._exact(n) if n else b""
        if masked: data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        return op, data
    def _exact(self, n):
        buf = b""
        while len(buf) < n:
            c = self.sock.recv(n - len(buf))
            if not c: raise OSError("closed")
            buf += c
        return buf
    def close(self):
        with self.lock:
            if self.closed: return
            self.closed = True
            try: self.sock.sendall(ws_frame(0x8, struct.pack(">H", 1001)))
            except OSError: pass
            try: self.sock.close()
            except OSError: pass


class KickAura:
    def __init__(self, bpm=120, quiet=False, single_kick=False):
        self.bpm = bpm
        self.quiet = quiet
        self.single_kick = single_kick
        self.kick_at = None
        self.started = time.time()
        self.started_ms = int(self.started * 1000)
        self.beat_s = 60.0 / bpm
        self.token = "kick-" + base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")
        self.clients = set()
        self.lock = threading.Lock()
        self.running = True
        self.seq = 0
        self.phase = 0
        self.last_features = {
            "type": "features", "seq": 0, "ts_ms": self.started_ms, "level": 0.0,
            "bands": [0.0] * 8, "onset": False, "centroid": 0.2,
            "flatness": 0.1, "silence": False,
        }
        self.config = {
            "intensity": 0.8, "reduced_motion": False, "capture": "pulse",
            "theme_opt_in": False, "enabled": True,
            "preset": "cope + martin - mother-of-pearl",
            "opacity": 0.75, "behavior": "balanced", "mood_reactive": True,
            "accent_pulse": True, "auto_preset": True, "motion": "music",
            "behavior_profile": {
                "intensity_ceiling": 1.0, "pulse_hz_max": 1.0,
                "preset_family": "liquid", "blend_ms": 1200,
                "mood_gain_scale": 1.0, "allow_strobe": True, "hard_pulse": True,
            },
        }

    def beat_phase(self, t=None):
        t = time.time() if t is None else t
        return ((t - self.started) % self.beat_s) / self.beat_s

    def samples(self, n=1024):
        out = []
        t0 = time.time()
        for i in range(n):
            t = t0 + i / 48000.0
            ph = ((t - self.started) % self.beat_s)
            # Kick: pitch-swept thump decaying over ~160 ms.
            is_kick = False
            kt = ph
            if self.single_kick:
                if self.kick_at is not None and 0.0 <= (t - self.kick_at) < 0.16:
                    is_kick = True
                    kt = t - self.kick_at
            elif ph < 0.16 and not self.quiet:
                is_kick = True
            if is_kick:
                env = math.exp(-kt / 0.045)
                freq = 150.0 * math.exp(-kt / 0.035) + 42.0
                v = env * math.sin(2 * math.pi * freq * kt)
                v += env * 0.35 * math.sin(2 * math.pi * 1800 * kt)  # beater click
            else:
                v = 0.0
            # Quiet musical bed so "silence" stays false and the preset drifts.
            v += 0.035 * math.sin(2 * math.pi * 55.0 * t)
            v += 0.018 * math.sin(2 * math.pi * 110.0 * t + 0.7)
            out.append(max(-1.0, min(1.0, v)))
        self.phase += n
        return out

    def feeder(self):
        last_features = 0.0
        while self.running:
            t = time.time()
            with self.lock:
                clients = list(self.clients)
            if clients:
                self.seq += 1
                pcm = self.samples(1024)
                rms = math.sqrt(sum(v * v for v in pcm) / len(pcm))
                for c in clients:
                    c.send_pcm(self.seq, pcm)
                if t - last_features >= 0.05:
                    last_features = t
                    ph = self.beat_phase(t)
                    if self.single_kick:
                        ph = ((t - self.kick_at) / self.beat_s) if self.kick_at is not None else 0.0
                    onset = (0.0 <= (t - self.kick_at) < 0.10) if (self.single_kick and self.kick_at is not None) else (ph < 0.10)
                    level = min(1.0, rms * 2.4)
                    bands = [max(0.0, level * (1.0 - i / 9.0)) for i in range(8)]
                    self.last_features = {
                        "type": "features", "seq": self.seq, "ts_ms": int(t * 1000),
                        "level": level, "bands": bands,
                        "onset": onset, "centroid": 0.25 + 0.3 * ph,
                        "flatness": 0.08, "silence": False,
                    }
                    for c in clients:
                        c.send_json(self.last_features)
            time.sleep(0.0213)

    def start(self, port=0):
        aura = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *a): pass
            def _json(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data)
            def _authorized(self, q):
                if self.headers.get("Authorization", "") == "Bearer " + aura.token: return True
                return q.get("token", [""])[0] == aura.token
            def do_GET(self):
                p = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(p.query)
                if p.path == "/api/stream": return self._ws(q)
                if (p.path == "/healthz" or p.path.startswith("/api/")) and not self._authorized(q):
                    return self._json(401, {"error": "unauthorized"})
                if p.path == "/healthz":
                    return self._json(200, {"ok": True, "version": "0.1.0", "pid": os.getpid(),
                                            "capture": "pulse", "rate": 48000,
                                            "clients": len(aura.clients),
                                            "bpm": aura.bpm, "started_ms": aura.started_ms})
                if p.path == "/api/state":
                    body = dict(aura.last_features)
                    body.update({"enabled": aura.config["enabled"], "mood": "streaming",
                                 "intensity": aura.config["intensity"], "preset": None,
                                 "opacity": aura.config["opacity"],
                                 "behavior": aura.config["behavior"],
                                 "mood_reactive": True, "accent_pulse": True,
                                 "auto_preset": True, "motion": "music"})
                    return self._json(200, body)
                if p.path == "/api/kick":
                    aura.kick_at = time.time()
                    return self._json(200, {"ok": True, "kick_at_ms": int(aura.kick_at * 1000)})
                if p.path == "/api/config":
                    return self._json(200, aura.config)
                if p.path == "/api/presets":
                    return self._file("presets.json")
                return self._static(p.path)
            def do_POST(self):
                p = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(p.query)
                if not self._authorized(q): return self._json(401, {"error": "unauthorized"})
                n = int(self.headers.get("Content-Length", "0"))
                try: body = json.loads(self.rfile.read(n) or b"{}")
                except ValueError: return self._json(400, {"error": "bad json"})
                if isinstance(body, dict): aura.config.update(body)
                return self._json(200, {"ok": True, "applied": body})
            def _file(self, name):
                data = open(os.path.join(WEB, name), "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data)
            def _static(self, path):
                name = "index.html" if path in ("/", "") else path.lstrip("/")
                target = os.path.realpath(os.path.join(WEB, name))
                if not target.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(target):
                    return self._json(404, {"error": "not found"})
                data = open(target, "rb").read()
                ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                         ".json": "application/json", ".css": "text/css; charset=utf-8"}.get(
                             os.path.splitext(target)[1], "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers(); self.wfile.write(data)
            def _ws(self, q):
                if q.get("token", [""])[0] != aura.token:
                    return self._json(401, {"error": "unauthorized"})
                key = self.headers.get("Sec-WebSocket-Key", "")
                accept = base64.b64encode(hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response(101, "Switching Protocols")
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept)
                self.end_headers(); self.wfile.flush()
                self.close_connection = True
                c = Client(self.connection)
                with aura.lock: aura.clients.add(c)
                # The page connects after it has built the visualizer; send the
                # config now so a server-chosen preset is not lost during boot.
                c.send_json(dict({"type": "config"}, **aura.config))
                try:
                    while aura.running and not c.closed:
                        try: op, data = c.recv_frame(timeout=0.5)
                        except socket.timeout: continue
                        except OSError: break
                        if op == 0x8: break
                        if op == 0x9: c.send(0xA, data)
                        elif op == 0x1:
                            try: msg = json.loads(data)
                            except ValueError: continue
                            if msg.get("type") == "ping": c.send_json({"type": "pong"})
                finally:
                    with aura.lock: aura.clients.discard(c)
                    c.close()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        threading.Thread(target=self.feeder, daemon=True).start()
        return self.port

    def stop(self):
        self.running = False
        with self.lock:
            cs = list(self.clients); self.clients.clear()
        for c in cs: c.close()
        try: self.httpd.shutdown(); self.httpd.server_close()
        except Exception: pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--bpm", type=int, default=120)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--single-kick", action="store_true")
    a = ap.parse_args()
    s = KickAura(a.bpm, quiet=a.quiet, single_kick=a.single_kick)
    port = s.start(a.port)
    print(json.dumps({"port": port, "token": s.token, "bpm": a.bpm,
                      "started_ms": s.started_ms}), flush=True)
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt:
        s.stop()
