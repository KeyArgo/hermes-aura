#!/usr/bin/env python3
"""Dense in-page probe: does the visual respond on the synthetic kick?

The 180 s proof samples over CDP every ~0.5 s, which aliases a 120 BPM beat.
This probe runs the sampler inside the page at ~25 Hz for 20 s, so the phase
profile is not dominated by round-trip latency. It is a supplement to
repro_local.py, not a freeze proof.
"""
import argparse, json, math, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from repro_local import Chrome, start_server, wait_ready  # noqa: E402

SAMPLER = """
(async (startedMs, beatMs, seconds) => {
  const out = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const s = window.__aura.sampleNow();
    if (s) out.push({wall: Date.now(), mean: s.mean, lit: s.lit, hash: s.hash,
                     grid: s.grid, frames: s.frames});
    await new Promise((r) => setTimeout(r, 40));
  }
  return out;
})(%d, %f, %f)
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=20.0)
    ap.add_argument("--bpm", type=int, default=120)
    ap.add_argument("--out", default="/tmp/aura-kick-probe.json")
    a = ap.parse_args()
    srv, info = start_server(a.bpm)
    chrome = Chrome()
    tab = None
    try:
        url = "http://127.0.0.1:%d/?token=%s&overlay=1" % (info["port"], info["token"])
        tab = chrome.new_tab(url)
        wait_ready(tab)
        time.sleep(2.0)
        beat_ms = 60000.0 / a.bpm
        tab.ws.settimeout(a.seconds + 30.0)
        rows = tab.ev(SAMPLER % (info["started_ms"], beat_ms, a.seconds))
        if not rows:
            raise RuntimeError("no samples")
        bins = [[] for _ in range(20)]
        changes = [[] for _ in range(20)]
        prev = None

        def grid_delta(a, b):
            if not a or not b or len(a) != len(b): return 0.0
            return sum(abs(x - y) for x, y in zip(a, b)) / len(a)

        for r in rows:
            phase = ((r["wall"] - info["started_ms"]) % beat_ms) / beat_ms
            b = min(19, int(phase * 20))
            bins[b].append(r)
            if prev is not None:
                changes[b].append(grid_delta(r.get("grid"), prev.get("grid")))
            prev = r
        mean_bins = [round(sum(x["mean"] for x in b) / len(b), 2) if b else None for b in bins]
        lit_bins = [round(sum(x["lit"] for x in b) / len(b), 1) if b else None for b in bins]
        change_bins = [round(sum(c) / len(c), 2) if c else None for c in changes]
        # Kick is phase 0.0-0.32 (160 ms of a 500 ms beat). Compare it with the
        # quiet half of the beat, and allow a 100-200 ms visual latency by also
        # reporting a shifted window.
        def window(vals, lo, hi):
            picked = [v for i, v in enumerate(vals) if v is not None and lo <= i / 20.0 < hi]
            return sum(picked) / len(picked) if picked else None
        report = {
            "seconds": a.seconds,
            "samples": len(rows),
            "mean_bins": mean_bins,
            "lit_bins": lit_bins,
            "change_bins": change_bins,
            "kick_mean": window(mean_bins, 0.0, 0.32),
            "quiet_mean": window(mean_bins, 0.5, 1.0),
            "kick_change": window(change_bins, 0.0, 0.32),
            "quiet_change": window(change_bins, 0.5, 1.0),
            "lagged_kick_change": window(change_bins, 0.2, 0.52),
            "peak_change_phase": max(
                ((i / 20.0, v) for i, v in enumerate(change_bins) if v is not None),
                key=lambda x: x[1])[0] if any(v is not None for v in change_bins) else None,
        }
        Path(a.out).write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return 0
    finally:
        if tab: tab.close()
        chrome.close()
        srv.terminate()
        try: srv.wait(timeout=5)
        except Exception: srv.kill()


if __name__ == "__main__":
    raise SystemExit(main())
