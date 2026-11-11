"""Reproducible Aura demo recorder.

Why this exists: the first demo looked weak because the visualizer was fed a pure
sine tone — Butterchurn had no spectrum to react to, so every preset collapsed to
one glowing ring — and because presets were picked by name instead of measured.

This script does both properly:

  1. synthesises a 120 BPM loop (kick, hats, bass, chords, lead) and streams it as
     the CONTRACT §2 PCM payload through the fake server in tests/e2e,
  2. scores every preset in web/presets.json by sampling the page's own drawing
     buffer (mean brightness, lit coverage, frame churn) via __aura.sampleNow(),
  3. records the top-ranked presets through CDP screencast across the agent moods,
  4. writes an MP4 and a handful of stills.

Usage:
    .venv/bin/python tools/record_demo.py [--out DIR] [--seconds N] [--window WxH]

Requires: the shared venv (websocket-client), ffmpeg, Chrome.
Nothing here is shipped to users; it is the demo/gate tool.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "tests", "e2e"))

from test_viz_e2e import FakeAura, TOKEN  # noqa: E402

CHROME = next((p for p in ("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
                           shutil.which("chromium") or "") if p and os.path.exists(p)), None)
SR = 48000


def build_music(seconds: float, seed: int = 11) -> list[float]:
    """A broadband 120 BPM loop: presets need spectrum and transients to move."""
    random.seed(seed)
    n = int(SR * seconds)
    buf = [0.0] * n

    def add(start, length, fn):
        s = int(start * SR)
        for i in range(int(length * SR)):
            j = s + i
            if j < n:
                buf[j] += fn(i / SR)

    def kick(t):
        return 0.95 * math.exp(-t * 9.0) * math.sin(2 * math.pi * (150 * math.exp(-t * 24.0) + 48) * t)

    def hat(t):
        return 0.30 * math.exp(-t * 55.0) * (random.random() * 2 - 1)

    def snare(t):
        return 0.45 * math.exp(-t * 18.0) * ((random.random() * 2 - 1) * 0.7 + 0.3 * math.sin(2 * math.pi * 190 * t))

    def bass(t, hz):
        return 0.42 * math.exp(-t * 3.2) * (math.sin(2 * math.pi * hz * t) + 0.35 * math.sin(4 * math.pi * hz * t))

    def chord(t, freqs):
        env = min(1.0, t * 6) * math.exp(-t * 0.9)
        return 0.16 * env * sum(math.sin(2 * math.pi * f * t) for f in freqs)

    def lead(t, hz):
        vib = 1 + 0.012 * math.sin(2 * math.pi * 5.2 * t)
        return 0.22 * math.exp(-t * 1.6) * min(1.0, t * 40) * (
            math.sin(2 * math.pi * hz * vib * t) + 0.4 * math.sin(4 * math.pi * hz * vib * t))

    beat, t, k = 0.5, 0.0, 0
    bassline = [55.0, 55.0, 73.4, 55.0, 49.0, 49.0, 65.4, 55.0]
    chords = [(220, 277, 330), (196, 247, 294), (174, 220, 261), (196, 247, 294)]
    melody = [440, 494, 523, 587, 523, 494, 440, 392]
    while t < seconds - 1:
        add(t, 0.5, kick)
        if k % 2 == 1:
            add(t, 0.3, snare)
        for h in (0.0, 0.25):
            add(t + h, 0.12, hat)
        add(t, 0.45, lambda x, hz=bassline[k % 8]: bass(x, hz))
        if k % 4 == 0:
            add(t, 2.0, lambda x, c=chords[(k // 4) % 4]: chord(x, c))
        add(t, 0.4, lambda x, hz=melody[k % 8]: lead(x, hz))
        t += beat
        k += 1
    peak = max(abs(v) for v in buf) or 1.0
    return [0.85 * v / peak for v in buf]


class CDP:
    def __init__(self, width: int, height: int):
        self.prof = tempfile.mkdtemp()
        assert CHROME
        self.proc = subprocess.Popen(
            [CHROME, "--headless=new", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
             f"--user-data-dir={self.prof}", "--remote-debugging-port=0", "--remote-allow-origins=*",
             f"--window-size={width},{height}", "--force-device-scale-factor=1", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import websocket

        for _ in range(100):
            if os.path.exists(os.path.join(self.prof, "DevToolsActivePort")):
                break
            time.sleep(0.2)
        dport = open(os.path.join(self.prof, "DevToolsActivePort")).read().split()[0]
        tab = json.load(urllib.request.urlopen(urllib.request.Request(
            f"http://127.0.0.1:{dport}/json/new?about:blank", method="PUT")))
        self.ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=2.0)
        self.seq = 0
        self.call("Page.enable")
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})

    def send(self, method, params=None):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        return self.seq

    def call(self, method, params=None, timeout=15):
        target = self.send(method, params)
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                continue
            if msg.get("id") == target:
                return msg
        return None

    def ev(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True,
                                           "returnByValue": True})
        return ((r or {}).get("result", {}) or {}).get("result", {}).get("value")

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.prof, ignore_errors=True)


def score_presets(cdp, aura, names):
    out = []
    for name in names:
        aura.send_preset(name, blend_ms=0)
        time.sleep(1.6)
        a = cdp.ev("window.__aura && window.__aura.sampleNow()") or {}
        time.sleep(0.8)
        b = cdp.ev("window.__aura && window.__aura.sampleNow()") or {}
        pixels = max(1, (a.get("w", 0) * a.get("h", 0)) // 4)
        out.append({
            "preset": name,
            "mean": a.get("mean", 0),
            "coverage": round(a.get("lit", 0) / pixels, 3),
            "churn": round((1.0 if b.get("hash") != a.get("hash") else 0.0)
                           + abs(b.get("mean", 0) - a.get("mean", 0)) / 255.0, 3),
        })
        print("  %-52s mean=%3d coverage=%.2f churn=%.2f"
              % (name, out[-1]["mean"], out[-1]["coverage"], out[-1]["churn"]), flush=True)
    out.sort(key=lambda s: (s["mean"] * 0.6 + s["coverage"] * 120 + s["churn"] * 40), reverse=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(REPO, ".demo"))
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--window", default="960x600")
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()
    width, height = (int(x) for x in args.window.split("x"))

    frames_dir = os.path.join(args.out, "frames")
    shutil.rmtree(args.out, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)

    music = build_music(max(30.0, args.seconds + 10))
    pos = [0]

    def samples(n=1024):
        out = [music[(pos[0] + i) % len(music)] for i in range(n)]
        pos[0] += n
        return out

    aura = FakeAura()
    aura._tone_samples = samples
    aura.start()
    aura.mode = "tone"
    aura.intensity = 1.0
    cdp = CDP(width, height)
    frames = []
    try:
        cdp.call("Page.navigate", {"url": f"http://127.0.0.1:{aura.port}/?token={TOKEN}"})
        for _ in range(120):
            s = cdp.ev("window.__aura && window.__aura.snapshot()")
            if s and s.get("ready") and s.get("socketState") == "connected":
                break
            time.sleep(0.25)
        aura.send_config()
        time.sleep(1.5)

        catalog = json.load(open(os.path.join(REPO, "web", "presets.json")))
        print("scoring %d presets" % len(catalog["presets"]), flush=True)
        ranked = score_presets(cdp, aura, [p["name"] for p in catalog["presets"]])
        json.dump(ranked, open(os.path.join(args.out, "preset-scores.json"), "w"), indent=2)
        top = [s["preset"] for s in ranked[:args.top]]
        print("TOP:", json.dumps(top), flush=True)

        moods = ["thinking", "approval", "error", "streaming"]
        showcase = top[:args.top]
        # Two segments, because the mood engine deliberately overrides an explicit
        # preset with the mood's family. Recording them together means the dense
        # presets are never actually shown, which is what made the first attempt
        # look sparse: 60 % music-only showcase, then 40 % agent-mood sequence.
        show_s = args.seconds * 0.6
        mood_s = args.seconds * 0.4

        def drive():
            per = show_s / max(1, len(showcase))
            for name in showcase:
                aura.send_preset(name, blend_ms=900)
                time.sleep(per)
            per = mood_s / len(moods)
            for mood in moods:
                aura.send_mood(mood, 0.9, int(per * 1000) + 400)
                time.sleep(per)
                aura.send_mood("idle", 0.6, 1200)
                time.sleep(0.3)

        threading.Thread(target=drive, daemon=True).start()
        cdp.call("Page.startScreencast", {"format": "jpeg", "quality": 85, "maxWidth": width,
                                          "maxHeight": height, "everyNthFrame": 1})
        t0 = time.time()
        while time.time() - t0 < args.seconds + 1.0:
            try:
                msg = json.loads(cdp.ws.recv())
            except Exception:
                continue
            if msg.get("method") == "Page.screencastFrame":
                p = msg["params"]
                idx = len(frames) + 1
                path = os.path.join(frames_dir, "f%04d.jpg" % idx)
                open(path, "wb").write(base64.b64decode(p["data"]))
                frames.append((path, p.get("timestamp")))
                cdp.ws.send(json.dumps({"id": 90000 + idx, "method": "Page.screencastFrameAck",
                                        "params": {"sessionId": p["sessionId"]}}))
        cdp.call("Page.stopScreencast")
    finally:
        cdp.close()
        aura.stop()

    if not frames:
        raise SystemExit("no screencast frames captured")

    ts = [t for _, t in frames if t]
    dur = (ts[-1] - ts[0]) if len(ts) > 1 else args.seconds
    fps = max(8.0, min(30.0, (len(frames) - 1) / dur if dur else 12.0))
    mp4 = os.path.join(args.out, "aura-demo.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-framerate", "%.2f" % fps,
                    "-i", os.path.join(frames_dir, "f%04d.jpg"), "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4], check=True)
    stills = []
    # Stills come from the music-only showcase, not the mood tail: the mood
    # engine picks its own family and those frames are not the curated picks.
    for frac in (0.08, 0.20, 0.32, 0.44, 0.56):
        i = max(1, min(len(frames), int(len(frames) * frac)))
        hero = os.path.join(args.out, "hero-%02d.jpg" % int(frac * 100))
        shutil.copy(frames[i - 1][0], hero)
        stills.append(hero)
    print("VIDEO:", mp4, os.path.getsize(mp4) // 1024, "KB", len(frames), "frames", "fps=%.1f" % fps)
    print("STILLS:", json.dumps(stills))


if __name__ == "__main__":
    main()
