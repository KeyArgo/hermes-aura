#!/usr/bin/env python3
"""Why is the canvas black under tone with the new default? Time-series check."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.start()
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))

for label, mode_at_boot, preset in [
    ("shifter boot-tone", "tone", None),
    ("shifter boot-silence->tone", "silence", None),
    ("alien boot-silence->tone", "silence", "Flexi - alien fish pond"),
]:
    srv.mode = mode_at_boot
    e2e.wait_ready(tab, timeout=40) if False else None
    tab.navigate("about:blank")
    time.sleep(0.3)
    tab.navigate(e2e.page_url(srv.port))
    snap = e2e.wait_for(tab, "window.__aura && window.__aura.snapshot()",
                        lambda s: s and s.get("ready"), timeout=30, label="ready")
    if preset:
        srv.send_preset(preset, blend_ms=0)
        time.sleep(1.0)
    srv.mode = "tone"
    print("== %s preset=%s" % (label, e2e.snapshot(tab)["preset"]))
    for i in range(8):
        s = e2e.sample(tab)
        print("  t+%2.1f mean=%4s lit=%6s frames=%s" % (
            i * 2, s and s["mean"], s and s["lit"], s and s["frames"]))
        time.sleep(2)

tab.close()
srv.stop()
chrome.close()
