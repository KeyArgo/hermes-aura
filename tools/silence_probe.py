"""Silence probe: does each curated preset go black when the audio stops?

The e2e asserts the DEFAULT preset is near-black in silence (mean<=3). This checks
the whole curated set in one Chrome session, because a rich preset that keeps
glowing with no audio is a bug (the visual should follow the audio, not free-run).

Usage: .venv/bin/python tools/silence_probe.py --repo /path/to/worktree [--json out.json]
"""
import argparse
import json
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tools"))
from record_demo import CDP  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    repo = os.path.abspath(args.repo)
    sys.path.insert(0, os.path.join(repo, "tests", "e2e"))
    from test_viz_e2e import FakeAura, TOKEN  # noqa: E402

    catalog = json.load(open(os.path.join(repo, "web", "presets.json")))
    names = [catalog["default"]] + [p["name"] for p in catalog["presets"]]
    aura = FakeAura()
    aura.start()
    aura.mode = "silence"
    cdp = CDP(640, 400)
    rows = []
    try:
        cdp.call("Page.navigate", {"url": "http://127.0.0.1:%d/?token=%s" % (aura.port, TOKEN)})
        for _ in range(120):
            s = cdp.ev("window.__aura && window.__aura.snapshot()")
            if s and s.get("ready") and s.get("socketState") == "connected":
                break
            time.sleep(0.25)
        aura.send_config()
        time.sleep(1.0)
        for name in names:
            aura.send_preset(name, blend_ms=0)
            time.sleep(2.2)
            a = cdp.ev("window.__aura && window.__aura.sampleNow()") or {}
            time.sleep(1.0)
            b = cdp.ev("window.__aura && window.__aura.sampleNow()") or {}
            ok = a.get("mean", 99) <= 3 and b.get("mean", 99) <= 3
            rows.append({"preset": name, "meanA": a.get("mean"), "meanB": b.get("mean"),
                         "litFrac": round(a.get("lit", 0) / max(1, (a.get("w", 0) * a.get("h", 0)) // 4), 3),
                         "ok": ok})
            print("%-56s A=%3s B=%3s lit=%.3f %s" % (name[:56], a.get("mean"), b.get("mean"),
                                                     rows[-1]["litFrac"], "PASS" if ok else "FAIL"), flush=True)
    finally:
        cdp.close()
        aura.stop()
    bad = [r["preset"] for r in rows if not r["ok"]]
    print("\n%d/%d dark in silence; %d still glowing: %s" % (len(rows) - len(bad), len(rows), len(bad), bad))
    if args.json:
        json.dump(rows, open(args.json, "w"), indent=2)


if __name__ == "__main__":
    main()
