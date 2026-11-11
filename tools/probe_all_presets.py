#!/usr/bin/env python3
"""Fast compile/black/static screen for every preset in the vendored packs.

Reuses the e2e harness (muted headless Chrome + FakeAura) and the PROBE_JS
measurement from tests/e2e/probe_presets.py. Unlike the strobe-grade quick/deep
passes, this runs two short samples per preset: enough to catch Butterchurn
compile/load failures and presets that render black or near-static, without
spending minutes on every candidate.

Usage (repo root, venv python):
  python tools/probe_all_presets.py [names.json] [--out tests/e2e/all_results.json]
  python tools/probe_all_presets.py --from-scored /tmp/scored.json
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "e2e"))

import test_viz_e2e as e2e  # noqa: E402
from probe_presets import PROBE_JS, collapse  # noqa: E402

EXTRA_GLOBALS = ["butterchurnPresetsExtra", "butterchurnPresetsExtra2", "butterchurnPresetsMD1"]


class Probe:
    def __init__(self):
        self.chrome = e2e.Chrome()
        self.aura = e2e.FakeAura()
        self.aura.start()
        self.tab = self.chrome.new_tab(e2e.page_url(self.aura.port))
        self.tab.ws.settimeout(90)
        self.aura.mode = "tone"
        self._wait_ready()

    def _wait_ready(self):
        e2e.wait_ready(self.tab, timeout=40)
        # Extras are injected after the first frame; wait for all three.
        e2e.wait_for(
            self.tab,
            "(%s).every((n) => window[n] && typeof window[n].getPresets === 'function')"
            % json.dumps(EXTRA_GLOBALS),
            lambda v: v is True,
            timeout=60,
            label="extra packs loaded",
        )
        self.aura.send_preset("Flexi - mindblob [shiny mix]", blend_ms=0)
        time.sleep(0.6)

    def recover(self):
        """Replace a tab whose renderer stopped answering CDP."""
        try:
            self.tab.close()
        except Exception:
            pass
        self.tab = self.chrome.new_tab(e2e.page_url(self.aura.port))
        self.tab.ws.settimeout(90)
        self.aura.mode = "tone"
        self._wait_ready()

    def close(self):
        try:
            self.tab.close()
        finally:
            self.aura.stop()
            self.chrome.close()

    def load(self, name):
        self.aura.send_preset(name, blend_ms=0)
        return e2e.wait_for(
            self.tab, "window.__aura.snapshot().preset",
            lambda p: p == name, timeout=25, label="preset load %r" % name)

    def measure(self, name, settle=0.35, samples=2, interval=0.25):
        self.load(name)
        time.sleep(settle)
        self.tab.ev("window.__probeGrid = null")
        rows = []
        for _ in range(samples):
            t0 = time.time()
            r = self.tab.ev(PROBE_JS)
            if r:
                r["preset"] = name
                rows.append(r)
            time.sleep(max(0.03, interval - (time.time() - t0)))
        return rows


def load_names(argv):
    if "--from-scored" in argv:
        path = Path(argv[argv.index("--from-scored") + 1])
        return [r["name"] for r in json.loads(path.read_text())]
    for arg in argv[1:]:
        if not arg.startswith("--") and arg.endswith(".json"):
            data = json.loads(Path(arg).read_text())
            return [r["name"] if isinstance(r, dict) else r for r in data]
    scored = ROOT / "tests" / "e2e" / "all_presets.json"
    if scored.exists():
        return json.loads(scored.read_text())
    raise SystemExit("pass a names JSON file (or --from-scored)")


def main():
    argv = sys.argv
    out_path = ROOT / "tests" / "e2e" / "all_results.json"
    if "--out" in argv:
        out_path = Path(argv[argv.index("--out") + 1])
    names = load_names(argv)
    resume = "--resume" in argv
    out = []
    done = set()
    if resume and out_path.exists():
        try:
            out = json.loads(out_path.read_text())
            done = {r["preset"] for r in out if not r.get("compileFailed") and "coverage" in r}
        except Exception:
            out, done = [], set()
    todo = [n for n in names if n not in done]
    print("%d candidates, %d already measured, %d to probe" % (
        len(names), len(done), len(todo)), flush=True)
    probe = Probe()
    try:
        for i, name in enumerate(todo):
            try:
                rows = probe.measure(name)
            except Exception as exc:
                out.append({"preset": name, "error": str(exc), "compileFailed": True})
                print("  FAIL %d/%d %r: %s" % (i + 1, len(todo), name, exc), flush=True)
                try:
                    probe.recover()
                except Exception as rexc:
                    print("  recover failed: %s" % rexc, flush=True)
                    break
                continue
            m = collapse(rows, 0.25)
            if not m:
                out.append({"preset": name, "error": "no samples", "compileFailed": True})
                print("  FAIL %d/%d %r: no samples" % (i + 1, len(todo), name), flush=True)
                continue
            out.append(m)
            if (i + 1) % 10 == 0 or i + 1 == len(todo):
                print("  %d/%d %s cov=%s motion=%s" % (
                    i + 1, len(todo), name, m["coverage"], m["motion"]), flush=True)
            if (i + 1) % 25 == 0:
                out_path.write_text(json.dumps(out, indent=1))
    finally:
        out_path.write_text(json.dumps(out, indent=1))
        probe.close()
    failures = sum(1 for r in out if r.get("compileFailed"))
    black = sum(1 for r in out if r.get("coverage", 1) < 0.02)
    static = sum(1 for r in out if r.get("coverage", 1) < 0.05 and r.get("motion", 1) < 0.10)
    print("\nmeasured %d, compile/load failures %d, black %d, near-static %d -> %s" % (
        len(out), failures, black, static, out_path), flush=True)


if __name__ == "__main__":
    main()
