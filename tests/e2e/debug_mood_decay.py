#!/usr/bin/env python3
"""Debug: mood persistence timings + silence-decay per candidate default."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.start()
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))
srv.mode = "tone"
e2e.wait_ready(tab, timeout=40)
srv.send_preset("Flexi - alien fish pond", blend_ms=0)
time.sleep(1.0)

print("== mood persistence (approval ttl 8000) ==")
srv.send_mood("approval", intensity=0.85, ttl_ms=8000)
for i in range(12):
    s = e2e.snapshot(tab)
    print("t=%.1f mood=%s prev=%s pulse=%s errors=%s" % (
        i * 0.4, s["mood"], s["previousMood"], s["pulsePeriodMs"], s["errors"][:2]))
    time.sleep(0.4)

print("== silence decay per candidate ==")
srv.send_mood("idle", intensity=0, ttl_ms=0)
for name in ["Flexi - alien fish pond", "cope + martin - mother-of-pearl",
             "suksma - vector exp 1 - couldn′t not", "Flexi + Martin - cascading decay swing",
             "Flexi, martin + geiss - dedicated to the sherwin maxawow",
             "Eo.S. + Zylot - skylight (Stained Glass Majesty mix)"]:
    srv.mode = "tone"
    srv.send_preset(name, blend_ms=0)
    time.sleep(3.0)
    srv.mode = "silence"
    row = []
    for delay in (1.0, 1.6, 2.8):
        time.sleep(0.6 if delay == 1.0 else (0.6 if delay == 1.6 else 1.2))
        s = e2e.sample(tab)
        row.append("t+%.1f mean=%s lit=%s" % (delay, s and s["mean"], s and s["lit"]))
    print("%-58s %s" % (name[:58], " | ".join(row)))

tab.close()
srv.stop()
chrome.close()
