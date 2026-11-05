#!/usr/bin/env python3
"""Boot-tone: does re-issuing the boot preset light it? + mindblob boot-tone."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.mode = "tone"
srv.start()
chrome = e2e.Chrome()

def boot():
    tab = chrome.new_tab(e2e.page_url(srv.port))
    e2e.wait_for(tab, "window.__aura && window.__aura.snapshot()",
                 lambda s: s and s.get("ready"), timeout=30, label="ready")
    return tab

try:
    for name in ["shifter - dark tides bdrv mix 2", "Flexi - mindblob [shiny mix]"]:
        tab = boot()
        print("== %s (boot preset)" % name)
        for t in (2, 4):
            time.sleep(2)
            s = e2e.sample(tab)
            print("  boot t+%d mean=%s lit=%s" % (t, s and s["mean"], s and s["lit"]))
        # re-issue the SAME preset mid-stream
        srv.send_preset(name, blend_ms=0)
        for t in (2, 4, 6):
            time.sleep(2)
            s = e2e.sample(tab)
            print("  reissued t+%d mean=%s lit=%s" % (t, s and s["mean"], s and s["lit"]))
        tab.close()
finally:
    srv.stop()
    chrome.close()
