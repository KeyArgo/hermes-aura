#!/usr/bin/env python3
"""shifter: loaded mid-stream under sustained tone -- does it ever light?"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.mode = "tone"
srv.start()
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))
e2e.wait_ready(tab, timeout=40)
srv.send_preset("Flexi - alien fish pond", blend_ms=0)
time.sleep(3)
e2e.wait_lit(tab, 0.2, timeout=15)
srv.send_preset("shifter - dark tides bdrv mix 2", blend_ms=0)
for i in range(10):
    s = e2e.sample(tab)
    print("t+%.1f mean=%4s lit=%6s" % (i * 1.5, s and s["mean"], s and s["lit"]), flush=True)
    time.sleep(1.5)
tab.close(); srv.stop(); chrome.close()
