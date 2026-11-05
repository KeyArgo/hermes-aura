#!/usr/bin/env python3
"""Visual probe for Aura preset curation (L5).

Renders candidate Butterchurn presets in muted headless Chrome (same harness as
test_viz_e2e.py: FakeAura in tone mode + CDP) and MEASURES, per preset:

  coverage  fraction of pixels with luma > 16 (does it fill the frame?)
  colour    std dev of per-pixel saturation on lit pixels (is it colourful?)
  hueEnt    entropy of the hue histogram of lit pixels (colour variety, 0..ln12)
  contrast  p90/p10 luma on lit pixels
  motion    mean abs luma delta on a 24x14 grid between samples (does it move?)
  strobe    >=12/255 grid-luma jumps per second, and peak delta
            (the rule presets.json documents)

Nothing here ships in the plugin; it exists so preset selection and the strobe
flags are measured, not guessed.

Usage (repo root, venv python):
  python tests/e2e/probe_presets.py names       # dump bundle preset names
  python tests/e2e/probe_presets.py quick       # 3-sample screen of every preset
  python tests/e2e/probe_presets.py deep FILE N # 6 s strobe-grade pass, top N of FILE
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_viz_e2e as e2e  # noqa: E402  (same-dir harness reuse)

HERE = Path(__file__).resolve().parent

# In-page measurement: one readPixels, scalars only. Keeps a 24x14 luma grid in
# window.__probeGrid so consecutive calls yield a frame-to-frame delta.
PROBE_JS = r"""
(() => {
  const c = document.getElementById('aura-canvas');
  if (!c) return null;
  const v = window.__aura && window.__aura._viz && window.__aura._viz();
  if (v) { try { v.render(); } catch (e) {} }  // buffer is not preserved: draw now
  const gl = c.getContext('webgl2');
  if (!gl) return null;
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  if (!w || !h) return null;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const GW = 24, GH = 14;
  const grid = new Float32Array(GW * GH);
  let lit = 0, n = 0, sat = 0, sat2 = 0;
  const lumaBucket = new Array(32).fill(0);
  const hue = new Array(12).fill(0);
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
      grid[Math.floor(y / h * GH) * GW + Math.floor(x / w * GW)] += l / 16;
      if (l > 16) {
        lit++;
        const s = mx === 0 ? 0 : (mx - mn) / mx;
        sat += s; sat2 += s * s;
        lumaBucket[Math.min(31, (l / 8) | 0)]++;
        if (s > 0.14 && mx > 40) {
          let hh;
          if (mx === r) hh = (((g - b) / (mx - mn)) / 6);
          else if (mx === g) hh = ((2 + (b - r) / (mx - mn)) / 6);
          else hh = ((4 + (r - g) / (mx - mn)) / 6);
          if (hh < 0) hh += 1;
          hue[Math.min(11, (hh * 12) | 0)] += 1;
        }
      }
    }
  }
  const litN = lit || 1;
  const colour = Math.sqrt(Math.max(0, sat2 / litN - (sat / litN) ** 2));
  let ent = 0; const hueTot = hue.reduce((a, b) => a + b, 0);
  if (hueTot > 0) for (const c1 of hue) { if (c1) { const p = c1 / hueTot; ent -= p * Math.log(p); } }
  let acc = 0, p10 = 0, p90 = 0;
  for (let b2 = 0; b2 < 32; b2++) {
    acc += lumaBucket[b2];
    if (!p10 && acc >= litN * 0.1) p10 = b2 * 8;
    if (!p90 && acc >= litN * 0.9) p90 = b2 * 8;
  }
  const compact = [];
  let motion = 0;
  for (let i = 0; i < grid.length; i++) compact.push(grid[i] / 16);
  const prev = window.__probeGrid || null;
  if (prev && prev.length === compact.length) {
    let d = 0;
    for (let i = 0; i < compact.length; i++) d += Math.abs(compact[i] - prev[i]);
    motion = d / compact.length;
  }
  window.__probeGrid = compact;
  return { w, h, litFrac: +(lit / n).toFixed(4), colour: +colour.toFixed(3),
           hueEnt: +ent.toFixed(3), p10, p90, motion: +motion.toFixed(3) };
})()
"""


class Probe:
    def __init__(self):
        self.chrome = e2e.Chrome()
        self.aura = e2e.FakeAura()
        self.aura.start()
        self.tab = self.chrome.new_tab(e2e.page_url(self.aura.port))
        self.aura.mode = "tone"
        e2e.wait_ready(self.tab, timeout=40)
        self.aura.send_preset("Flexi - mindblob [shiny mix]", blend_ms=0)
        time.sleep(1.0)

    def close(self):
        try:
            self.tab.close()
        finally:
            self.aura.stop()
            self.chrome.close()

    def names(self):
        return self.tab.ev("Object.keys(window.butterchurnPresets.getPresets())")

    def load(self, name):
        self.aura.send_preset(name, blend_ms=0)
        return e2e.wait_for(
            self.tab, "window.__aura.snapshot().preset",
            lambda p: p == name, timeout=10, label="preset load %r" % name)

    def measure(self, name, settle, samples, interval):
        self.load(name)
        time.sleep(settle)
        self.tab.ev("window.__probeGrid = null")  # reset motion baseline
        rows = []
        for _ in range(samples):
            t0 = time.time()
            r = self.tab.ev(PROBE_JS)
            if r:
                r["preset"] = name
                rows.append(r)
            time.sleep(max(0.05, interval - (time.time() - t0)))
        return rows


def collapse(rows, interval):
    """Sample series -> one metrics dict incl. the measured strobe verdict."""
    if len(rows) < 2:
        return None
    n = len(rows)
    durations = max(0.001, (n - 1) * interval)
    jumps12 = sum(1 for r in rows[1:] if r["motion"] >= 12) / durations
    peak = max(r["motion"] for r in rows[1:])
    return {
        "preset": rows[0]["preset"],
        "coverage": round(sum(r["litFrac"] for r in rows) / n, 4),
        "colour": round(sum(r["colour"] for r in rows) / n, 3),
        "hueEnt": round(sum(r["hueEnt"] for r in rows) / n, 3),
        "motion": round(sum(r["motion"] for r in rows[1:]) / (n - 1), 3),
        "p90": sum(r["p90"] for r in rows) // n,
        "p10": sum(r["p10"] for r in rows) // n,
        "jumpsPerSec": round(jumps12, 2),
        "peakDelta": round(peak, 2),
        "strobe": bool(jumps12 >= 0.5 or peak >= 25.0),
    }


def score(m):
    # rich = fills the frame, colourful, many hues, moves, contrast
    return (min(1.0, m["coverage"] / 0.75) * 3.0
            + min(1.0, m["colour"] / 0.30) * 2.0
            + min(1.0, m["hueEnt"] / 1.6) * 1.5
            + min(1.0, m["motion"] / 6.0) * 2.0
            + min(1.0, max(0, m["p90"] - m["p10"]) / 120.0) * 1.0)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "names"
    p = Probe()
    try:
        if cmd == "names":
            names = p.names()
            print(len(names), "presets in bundle")
            (HERE / "all_presets.json").write_text(json.dumps(names, indent=0))
        elif cmd == "quick":
            names = json.loads((HERE / "all_presets.json").read_text()) \
                if (HERE / "all_presets.json").exists() else p.names()
            print("%d candidates" % len(names), flush=True)
            out = []
            for i, name in enumerate(names):
                try:
                    rows = p.measure(name, settle=0.8, samples=4, interval=0.35)
                except AssertionError as e:
                    print("  skip %r: %s" % (name, e), flush=True)
                    continue
                m = collapse(rows, 0.35)
                if m:
                    out.append(m)
                if i % 25 == 0:
                    print("  %d/%d" % (i, len(names)), flush=True)
            (HERE / "quick_results.json").write_text(json.dumps(out, indent=1))
            out.sort(key=score, reverse=True)
            for r in out[:45]:
                print(r)
            print("total measured:", len(out))
        elif cmd == "deep":
            path = HERE / sys.argv[2]
            top_n = int(sys.argv[3]) if len(sys.argv) > 3 else 40
            ranked = sorted(json.loads(path.read_text()), key=score, reverse=True)
            names = [d["preset"] for d in ranked[:top_n]]
            print("deep pass over %d presets" % len(names), flush=True)
            out = []
            for i, name in enumerate(names):
                try:
                    # 6 s per preset at ~0.33 s sampling: strobe-grade timing
                    rows = p.measure(name, settle=1.2, samples=15, interval=0.4)
                except AssertionError as e:
                    print("  skip %r: %s" % (name, e), flush=True)
                    continue
                m = collapse(rows, 0.4)
                if m:
                    out.append(m)
                    print("%2d/%d %s" % (i, len(names), m), flush=True)
            (HERE / "deep_results.json").write_text(json.dumps(out, indent=1))
        elif cmd == "shots":
            # batch-render presets and screenshot each: shots spec = JSON list
            # of {preset, out}; optional set_metrics first for a common size.
            spec = json.loads(Path(sys.argv[2]).read_text())
            tab = p.tab
            tab.send("Emulation.setDeviceMetricsOverride", {
                "width": 1400, "height": 880, "deviceScaleFactor": 1, "mobile": False})
            out = []
            for item in spec:
                p.load(item["preset"])
                time.sleep(float(item.get("settle", 3.0)))
                data = tab.send("Page.captureScreenshot", {"format": "png"})
                path = Path(item["out"])
                path.parent.mkdir(parents=True, exist_ok=True)
                import base64
                path.write_bytes(base64.b64decode(data["data"]))
                m = p.tab.ev(PROBE_JS)
                m["preset"] = item["preset"]
                m["path"] = str(path)
                out.append(m)
                print(m, flush=True)
            (HERE / "shot_results.json").write_text(json.dumps(out, indent=1))
        else:
            print(__doc__)
    finally:
        p.close()


if __name__ == "__main__":
    main()
