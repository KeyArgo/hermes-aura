#!/usr/bin/env python3
"""Screen: which catalogue presets decay to near-black within the e2e window?"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.start()
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))
e2e.wait_ready(tab, timeout=40)

names = json.load(open("tests/e2e/all_presets.json"))
names.append("Flexi - mindblob [shiny mix]")  # the old default, as reference

for name in names:
    srv.mode = "tone"
    srv.send_preset(name, blend_ms=0)
    time.sleep(2.5)
    srv.mode = "silence"
    time.sleep(1.6)
    a = e2e.sample(tab)
    time.sleep(1.2)
    b = e2e.sample(tab)
    ok = a and b and a["mean"] <= 3 and b["mean"] <= 3 and abs(a["mean"] - b["mean"]) <= 1
    print("%-58s A mean=%3s lit=%6s | B mean=%3s lit=%6s %s" % (
        name[:58], a and a["mean"], a and a["lit"], b and b["mean"], b and b["lit"],
        "PASS" if ok else "fail"), flush=True)

tab.close()
srv.stop()
chrome.close()
