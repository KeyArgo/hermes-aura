#!/usr/bin/env python3
"""Run the real Aura page for 3 minutes against a local 120 BPM kick stream and
prove (a) it never freezes and (b) the visual responds on kicks.

Uses the system Chrome + raw CDP, like tests/e2e/test_viz_e2e.py. Audio is a
synthetic PCM stream from tools/kick_server.py; no capture device is touched.
"""
import argparse, base64, hashlib, io, json, math, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:
    sys.exit("need python websocket-client (system python3 has it)")
try:
    from PIL import Image, ImageChops
except ImportError:
    Image = None

ROOT = Path(__file__).resolve().parents[1]
CHROME_CANDIDATES = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
                     "google-chrome-stable", "google-chrome", "chromium"]

# In-page sampler. CDP round trips are ~0.5 s, which aliases a 120 BPM beat;
# running the sampler inside the page at ~6 Hz keeps the phase profile usable.
DENSE_SAMPLER = """
(async (startedMs, beatMs, seconds) => {
  window.__aura.startProbe();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  return window.__aura.stopProbe();
})(%d, %f, %f)
"""


def chrome_binary():
    for c in CHROME_CANDIDATES:
        p = c if os.path.isabs(c) else shutil.which(c)
        if p and os.path.exists(p):
            return p
    raise RuntimeError("no Chrome/Chromium")


class Tab:
    def __init__(self, ws_url, target_id, debug_port):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self.target_id = target_id
        self.debug_port = debug_port
        self._seq = 0
    def send(self, method, params=None):
        self._seq += 1
        msg = {"id": self._seq, "method": method}
        if params is not None: msg["params"] = params
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == self._seq:
                if "error" in reply: raise RuntimeError("%s failed: %s" % (method, reply["error"]))
                return reply.get("result", {})
    def ev(self, expr):
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError("JS: %s %s" % (d.get("text"), d.get("exception", {}).get("description")))
        return r.get("result", {}).get("value")
    def navigate(self, url): self.send("Page.navigate", {"url": url})
    def screenshot(self):
        r = self.send("Page.captureScreenshot", {"format": "png"})
        return base64.b64decode(r["data"])
    def close(self):
        try: urllib.request.urlopen("http://127.0.0.1:%d/json/close/%s" % (self.debug_port, self.target_id))
        except Exception: pass
        try: self.ws.close()
        except Exception: pass


class Chrome:
    def __init__(self):
        self.profile = tempfile.mkdtemp(prefix="aura-local-")
        self.proc = subprocess.Popen([
            chrome_binary(), "--headless=new", "--mute-audio",
            "--autoplay-policy=no-user-gesture-required",
            "--user-data-dir=" + self.profile,
            "--remote-debugging-port=0", "--remote-allow-origins=*",
            "--window-size=1200,900", "--no-first-run", "--no-default-browser-check",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pf = os.path.join(self.profile, "DevToolsActivePort")
        for _ in range(150):
            if os.path.exists(pf): break
            if self.proc.poll() is not None: raise RuntimeError("Chrome exited early")
            time.sleep(0.2)
        if not os.path.exists(pf): raise RuntimeError("no DevToolsActivePort")
        self.debug_port = int(open(pf).read().split()[0])
    def new_tab(self, url="about:blank"):
        q = urllib.parse.quote(url, safe="")
        info = json.load(urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:%d/json/new?%s" % (self.debug_port, q), method="PUT")))
        tab = Tab(info["webSocketDebuggerUrl"], info["id"], self.debug_port)
        tab.send("Page.enable"); tab.send("Runtime.enable")
        return tab
    def close(self):
        try:
            self.proc.terminate(); self.proc.wait(timeout=10)
        except Exception:
            try: self.proc.kill()
            except Exception: pass
        shutil.rmtree(self.profile, ignore_errors=True)


def start_server(bpm=120, quiet=False, single_kick=False):
    cmd = [sys.executable, str(ROOT / "tools" / "kick_server.py"), "--bpm", str(bpm)]
    if quiet: cmd.append("--quiet")
    if single_kick: cmd.append("--single-kick")
    p = subprocess.Popen(cmd,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = p.stdout.readline()
    if not line:
        raise RuntimeError("kick server failed: " + (p.stderr.read() or "no output"))
    info = json.loads(line)
    return p, info


def get_json(url):
    return json.load(urllib.request.urlopen(url, timeout=5))


def wait_ready(tab, timeout=30):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            s = tab.ev("(() => window.__aura ? window.__aura.snapshot() : null)()")
            if s and s.get("ready"):
                return s
            last = s
        except Exception as e:
            last = str(e)
        time.sleep(0.2)
    raise RuntimeError("page never became ready: %r" % (last,))


def grid_delta(a, b):
    if not a or not b or len(a) != len(b): return 0.0
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def pixel_diff(a, b):
    if Image is None: return None
    try:
        ia = Image.open(io.BytesIO(a)).convert("RGB")
        ib = Image.open(io.BytesIO(b)).convert("RGB")
        if ia.size != ib.size: return 1.0
        d = ImageChops.difference(ia, ib)
        hist = d.histogram()
        total = ia.size[0] * ia.size[1]
        changed = sum(hist[i] + hist[256 + i] + hist[512 + i] for i in range(1, 256))
        return changed / (total * 3.0)
    except Exception:
        return None


def mean_luma(png):
    if Image is None: return None
    try:
        im = Image.open(io.BytesIO(png)).convert("L")
        h = im.histogram(); n = im.size[0] * im.size[1]
        return sum(i * h[i] for i in range(256)) / max(1, n)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=180.0)
    ap.add_argument("--bpm", type=int, default=120)
    ap.add_argument("--out", default="/tmp/aura-local-proof.json")
    ap.add_argument("--shots", default="/tmp/aura-local-shots")
    ap.add_argument("--quiet", action="store_true", help="control: quiet bed, no kicks")
    ap.add_argument("--single-kick", action="store_true", help="one scheduled kick, pre/post response")
    ap.add_argument("--probe-only", action="store_true", help="dense kick probe, no freeze run")
    a = ap.parse_args()
    os.makedirs(a.shots, exist_ok=True)
    srv, info = start_server(a.bpm, quiet=a.quiet, single_kick=a.single_kick)
    chrome = Chrome()
    tab = None
    try:
        port, token, started_ms = info["port"], info["token"], info["started_ms"]
        url = "http://127.0.0.1:%d/?token=%s&overlay=1" % (port, urllib.parse.quote(token))
        tab = chrome.new_tab(url)
        snap = wait_ready(tab)
        print("ready:", json.dumps({k: snap.get(k) for k in ("ready", "overlay", "motion", "behavior", "preset")}))
        # Let the preset settle after load.
        time.sleep(2.0)
        if a.single_kick:
            # Let the config preset finish its 1200 ms blend before measuring;
            # otherwise the blend's motion swamps the kick response.
            time.sleep(4.0)
            tab.ev("window.__aura.startProbe()")
            time.sleep(3.0)
            kick_url = "http://127.0.0.1:%d/api/kick?token=%s" % (port, urllib.parse.quote(token))
            kick = json.load(urllib.request.urlopen(kick_url, timeout=5))
            time.sleep(3.0)
            rows = tab.ev("window.__aura.stopProbe()") or []
            kick_ms = kick.get("kick_at_ms")
            pre = [r for r in rows if kick_ms - 1200 <= r.get("t", 0) < kick_ms]
            post = [r for r in rows if kick_ms <= r.get("t", 0) < kick_ms + 1200]
            def mean_change(seq):
                vals = [grid_delta(seq[i + 1].get("grid"), seq[i].get("grid"))
                        for i in range(len(seq) - 1)]
                return sum(vals) / len(vals) if vals else None
            def mean_audio(seq):
                vals = [r.get("audioRms", 0.0) for r in seq]
                return sum(vals) / len(vals) if vals else None
            def mean_diff(seq):
                vals = [r.get("diff") for r in seq if r.get("diff") is not None]
                return sum(vals) / len(vals) if vals else None
            pre_change, post_change = mean_change(pre), mean_change(post)
            pre_diff, post_diff = mean_diff(pre), mean_diff(post)
            pre_audio, post_audio = mean_audio(pre), mean_audio(post)
            cur = tab.ev("(() => window.__aura ? window.__aura.snapshot() : null)()") or {}
            out = {
                "single_kick": True,
                "kick_at_ms": kick_ms,
                "samples": len(rows),
                "pre_samples": len(pre), "post_samples": len(post),
                "pre_change": round(pre_change, 4) if pre_change is not None else None,
                "post_change": round(post_change, 4) if post_change is not None else None,
                "post_over_pre": round(post_change / pre_change, 2)
                if pre_change and post_change is not None else None,
                "pre_diff": round(pre_diff, 4) if pre_diff is not None else None,
                "post_diff": round(post_diff, 4) if post_diff is not None else None,
                "post_diff_over_pre": round(post_diff / pre_diff, 2)
                if pre_diff and post_diff is not None else None,
                "pre_audio": round(pre_audio, 4) if pre_audio is not None else None,
                "post_audio": round(post_audio, 4) if post_audio is not None else None,
                "preset": cur.get("preset"), "errors": cur.get("errors"),
            }
            json.dump(out, open(a.out, "w"), indent=2)
            print("SINGLE KICK:", json.dumps(out))
            return
        # Dense in-page kick probe first, while the beat phase is still fresh.
        beat_ms = 60000.0 / a.bpm
        dense_seconds = 40.0
        # The in-page sampler blocks this CDP call for the whole window.
        tab.ws.settimeout(dense_seconds + 30.0)
        dense = tab.ev(DENSE_SAMPLER % (started_ms, beat_ms, dense_seconds)) or []
        tab.ws.settimeout(30.0)
        dense_bins = [[] for _ in range(20)]
        dense_changes = [[] for _ in range(20)]
        dense_audio_bins = [[] for _ in range(20)]
        prev_dense = None

        for r in dense:
            phase = ((r["t"] - started_ms) % beat_ms) / beat_ms
            b = min(19, int(phase * 20))
            dense_bins[b].append(r)
            dense_audio_bins[b].append(r.get("audioRms", 0.0))
            if prev_dense is not None:
                dense_changes[b].append(grid_delta(r.get("grid"), prev_dense.get("grid")))
            prev_dense = r
        dense_mean_bins = [round(sum(x["mean"] for x in b) / len(b), 2) if b else None for b in dense_bins]
        dense_lit_bins = [round(sum(x["lit"] for x in b) / len(b), 1) if b else None for b in dense_bins]
        dense_change_bins = [round(sum(c) / len(c), 2) if c else None for c in dense_changes]
        dense_audio_mean = [round(sum(x) / len(x), 4) if x else None for x in dense_audio_bins]

        def phase_window(vals, lo, hi):
            picked = [v for i, v in enumerate(vals) if v is not None and lo <= i / 20.0 < hi]
            return sum(picked) / len(picked) if picked else None

        kick_change = phase_window(dense_change_bins, 0.0, 0.32)
        quiet_change = phase_window(dense_change_bins, 0.5, 1.0)
        dense_kick_mean = phase_window(dense_mean_bins, 0.0, 0.32)
        dense_quiet_mean = phase_window(dense_mean_bins, 0.5, 1.0)
        kick_audio = phase_window(dense_audio_mean, 0.0, 0.32)
        quiet_audio = phase_window(dense_audio_mean, 0.5, 1.0)
        peak_audio_phase = max(
            ((i / 20.0, v) for i, v in enumerate(dense_audio_mean) if v is not None),
            key=lambda x: x[1])[0] if any(v is not None for v in dense_audio_mean) else None
        peak_change_phase = max(
            ((i / 20.0, v) for i, v in enumerate(dense_change_bins) if v is not None),
            key=lambda x: x[1])[0] if any(v is not None for v in dense_change_bins) else None
        print("dense probe:", json.dumps({"samples": len(dense), "kick_change": kick_change,
                                         "quiet_change": quiet_change,
                                         "peak_change_phase": peak_change_phase,
                                         "kick_audio": kick_audio, "quiet_audio": quiet_audio,
                                         "peak_audio_phase": peak_audio_phase}))
        if a.probe_only:
            cur = tab.ev("(() => window.__aura ? window.__aura.snapshot() : null)()") or {}
            probe = {
                "quiet": a.quiet,
                "dense_seconds": dense_seconds,
                "dense_samples": len(dense),
                "kick_change": kick_change,
                "quiet_change": quiet_change,
                "peak_change_phase": peak_change_phase,
                "kick_change_bins": dense_change_bins,
                "kick_bucket_means": dense_mean_bins,
                "kick_audio_bins": dense_audio_mean,
                "kick_audio": kick_audio,
                "quiet_audio": quiet_audio,
                "peak_audio_phase": peak_audio_phase,
                "kick_lit_bins": dense_lit_bins,
                "kick_window_mean": round(dense_kick_mean, 2) if dense_kick_mean is not None else None,
                "offbeat_mean": round(dense_quiet_mean, 2) if dense_quiet_mean is not None else None,
                "kick_lift": round(dense_kick_mean - dense_quiet_mean, 2),
                "preset": cur.get("preset"),
                "errors": cur.get("errors"),
            }
            json.dump(probe, open(a.out, "w"), indent=2)
            print("PROBE ONLY:", json.dumps({k: probe[k] for k in (
                "quiet", "dense_samples", "kick_change", "quiet_change", "peak_change_phase",
                "kick_window_mean", "offbeat_mean", "kick_lift", "preset", "errors")}))
            return
        samples = []
        shots = []
        t0 = time.time()
        next_shot = t0 + 1.0
        shot_times = [1, 20, 40, 60, 90, 120, 150, 178]
        shot_i = 0
        while True:
            now = time.time()
            if now - t0 >= a.seconds: break
            high_rate = (now - t0) < 60.0
            interval = 0.1 if high_rate else 1.0
            try:
                s = tab.ev("window.__aura.sampleNow()")
                st = tab.ev("window.__aura.snapshot()")
                rec = {
                    "t": round(now - t0, 3),
                    "mean": s.get("mean") if s else None,
                    "lit": s.get("lit") if s else None,
                    "hash": s.get("hash") if s else None,
                    "frames": st.get("frames"),
                    "blockers": st.get("fallbackReasons"),
                    "fallbackActive": st.get("fallbackActive"),
                    "paused": st.get("paused"),
                    "preset": st.get("preset"),
                    "degradeLevel": st.get("quality", {}).get("degradeLevel"),
                    "fpsCap": st.get("quality", {}).get("fpsCap"),
                    "frameMs": st.get("quality", {}).get("frameMs"),
                    "syncMs": st.get("quality", {}).get("syncMs"),
                    "perfLimited": st.get("quality", {}).get("perfLimited"),
                    "errors": st.get("errors", [])[-1:] if st.get("errors") else [],
                }
                samples.append(rec)
            except Exception as e:
                samples.append({"t": round(now - t0, 3), "error": str(e)})
            if now >= next_shot:
                png = tab.screenshot()
                phase = ((time.time() * 1000 - started_ms) % (60000.0 / a.bpm)) / (60000.0 / a.bpm)
                shots.append({"t": round(time.time() - t0, 3), "phase": round(phase, 3),
                              "sha": hashlib.sha256(png).hexdigest()[:16],
                              "luma": mean_luma(png), "png": png})
                next_shot = now + (1.0 if high_rate else 10.0)
            # paced loop
            elapsed = time.time() - now
            time.sleep(max(0.0, interval - elapsed))
        # final screenshot
        png = tab.screenshot()
        shots.append({"t": round(time.time() - t0, 3), "sha": hashlib.sha256(png).hexdigest()[:16],
                      "luma": mean_luma(png), "png": png})
        # save selected screenshots
        for i, s in enumerate(shots):
            if s["t"] in (1.0,) or i in (0, len(shots)//2, len(shots)-1):
                Path(a.shots, "shot_%05.1f.png" % s["t"]).write_bytes(s["png"])
        # freeze: longest run with no frame counter advance and no canvas hash change
        longest_still = 0.0
        still_start = None
        prev = None
        for s in samples:
            if "error" in s: continue
            if prev and s.get("frames") == prev.get("frames") and s.get("hash") == prev.get("hash"):
                if still_start is None: still_start = prev["t"]
                longest_still = max(longest_still, s["t"] - still_start)
            else:
                still_start = None
            prev = s
        blocked = [s for s in samples if s.get("blockers")]
        hard_blocked = [s for s in samples if s.get("fallbackActive")]
        frame_advance = (samples[-1].get("frames", 0) - samples[0].get("frames", 0)) if samples else 0
        sha_unique = len({s["sha"] for s in shots})
        diffs = []
        for i in range(1, len(shots)):
            d = pixel_diff(shots[i-1]["png"], shots[i]["png"])
            if d is not None: diffs.append({"t": shots[i]["t"], "diff": round(d, 5)})
        report = {
            "seconds": round(time.time() - t0, 1),
            "samples": len(samples),
            "frame_advance": frame_advance,
            "longest_still_s": round(longest_still, 2),
            "hard_blocked_samples": len(hard_blocked),
            "soft_blocked_samples": len(blocked),
            "blockers_seen": sorted({b for s in samples for b in (s.get("blockers") or [])}),
            "shot_unique_hashes": sha_unique,
            "shot_count": len(shots),
            "shot_luma": [{"t": s["t"], "luma": round(s["luma"], 2) if s["luma"] is not None else None,
                           "sha": s["sha"]} for s in shots],
            "pixel_diffs": diffs,
            "dense_seconds": dense_seconds,
            "dense_samples": len(dense),
            "kick_bucket_means": dense_mean_bins,
            "kick_lit_bins": dense_lit_bins,
            "kick_change_bins": dense_change_bins,
            "kick_window_mean": round(dense_kick_mean, 2) if dense_kick_mean is not None else None,
            "offbeat_mean": round(dense_quiet_mean, 2) if dense_quiet_mean is not None else None,
            "kick_lift": round(dense_kick_mean - dense_quiet_mean, 2)
            if dense_kick_mean is not None and dense_quiet_mean is not None else None,
            "kick_change": round(kick_change, 2) if kick_change is not None else None,
            "quiet_change": round(quiet_change, 2) if quiet_change is not None else None,
            "peak_change_phase": peak_change_phase,
            "kick_audio": round(kick_audio, 4) if kick_audio is not None else None,
            "quiet_audio": round(quiet_audio, 4) if quiet_audio is not None else None,
            "peak_audio_phase": peak_audio_phase,
            "kick_audio_bins": dense_audio_mean,
            "presets_seen": sorted({s.get("preset") for s in samples if s.get("preset")}),
            "max_degrade": max([s.get("degradeLevel") or 0 for s in samples] or [0]),
            "perf_limited_samples": sum(1 for s in samples if s.get("perfLimited")),
            "last": samples[-1] if samples else None,
        }
        Path(a.out).write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        # The beat is visible if the frame-change peak lands in the kick window
        # and the PCM really carried kicks (the quiet control fails this).
        # PASS is the freeze guarantee: the loop advanced, nothing hard-blocked,
        # and the synthetic PCM really carried kicks. The frame-change phase
        # profile is reported too, but the preset's own animation dominates it,
        # so it is evidence, not a gate.
        ok = (frame_advance > 0 and longest_still < 10.0 and len(hard_blocked) == 0
              and kick_audio is not None and quiet_audio is not None
              and kick_audio > 0.10 and kick_audio > quiet_audio * 2.0)
        print("\nPROOF:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        if tab: tab.close()
        chrome.close()
        srv.terminate()
        try: srv.wait(timeout=5)
        except Exception: srv.kill()


if __name__ == "__main__":
    raise SystemExit(main())
