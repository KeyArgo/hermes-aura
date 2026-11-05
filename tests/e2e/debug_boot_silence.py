#!/usr/bin/env python3
"""Boot-silence screen: preset loaded with NO audio ever -> near-black in ~4 s?

This is the exact e2e silence condition (page boots while FakeAura is in
silence mode). A candidate default must pass this AND look rich in tone.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

srv = e2e.FakeAura()
srv.start()  # silence mode
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))
e2e.wait_ready(tab, timeout=40)

# low silence-mean from the full decay screen, plus every catalogue preset
cands = ["$$$ Royal - Mashup (197)", "Geiss - Spiral Artifact",
         "martin, flexi, fishbrain + sto - enterstate [random mashup]",
         "martin - chain breaker", "Idiot - Star Of Annon",
         "suksma - uninitialized variabowl (hydroponic chronic)",
         "Zylot - Star Ornament", "martin - another kind of groove",
         "Krash + Illusion - Spiral Movement", "martin - disco mix 4",
         "martin - extreme heat", "martin - angel flight",
         "Eo.S. - glowsticks v2 05 and proton lights (+Krash′s beat code) _Phat_remix02b",
         "martin - frosty caves 2", "_Mig_085",
         "martin - reflections on black tiles", "Flexi - mindblob [shiny mix]",
         "shifter - dark tides bdrv mix 2", "_Mig_049",
         "Geiss - Reaction Diffusion 2", "Flexi - smashing fractals [acid etching mix]"]

for name in cands:
    try:
        srv.send_preset(name, blend_ms=0)
        e2e.wait_for(tab, "window.__aura.snapshot().preset",
                     lambda p: p == name, timeout=8, label="load")
    except AssertionError:
        print("%-58s LOAD FAIL" % name[:58])
        continue
    time.sleep(4.0)
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
