#!/usr/bin/env python3
"""Default-preset screen: boot-tone must light, boot-silence must go black.

Two fresh page loads per candidate (the boot state is what differs):
  A) boot while tone plays -> sample at +3..+9 s (must light, mean>10)
  B) boot in silence -> sample at +3 and +4.2 s (e2e window; mean<=3)
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_viz_e2e as e2e

CANDS = [
    "Flexi - alien fish pond",
    "flexi - what is the matrix",
    "suksma - vector exp 1 - couldn′t not",
    "$$$ Royal - Mashup (220)",
    "_Mig_049",
    "Eo.S. + Zylot - skylight (Stained Glass Majesty mix)",
    "Flexi, martin + geiss - dedicated to the sherwin maxawow",
    "Aderrasi - Songflower (Moss Posy)",
    "cope + martin - mother-of-pearl",
    "martin - ghost city",
    "Flexi + stahlregen - jelly showoff parade",
    "Flexi, fishbrain, Geiss + Martin - tokamak witchery",
    "Flexi - smashing fractals [acid etching mix]",
    "martin - fruit machine",
    "flexi - bouncing balls [double mindblob neon mix]",
    "Flexi - infused with the spiral",
    "martin - glass corridor",
    "Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)",
    "Flexi + Martin - cascading decay swing",
    "shifter - dark tides bdrv mix 2",
]

srv = e2e.FakeAura()
srv.start()
chrome = e2e.Chrome()

def fresh(mode):
    srv.mode = mode
    tab = chrome.new_tab(e2e.page_url(srv.port))
    e2e.wait_for(tab, "window.__aura && window.__aura.snapshot()",
                 lambda s: s and s.get("ready"), timeout=30, label="ready")
    return tab

try:
    for name in CANDS:
        # A: boot under tone
        tab = fresh("tone")
        srv.send_preset(name, blend_ms=0)
        time.sleep(1.0)
        lit = None
        for _ in range(5):
            time.sleep(1.6)
            s = e2e.sample(tab)
            if s and s["mean"] > 10:
                lit = s
                break
        tone_ok = bool(lit)
        tone_mean = lit and lit["mean"]
        tab.close()

        # B: boot in silence (preset = default? no: load candidate, no audio ever)
        tab = fresh("silence")
        srv.send_preset(name, blend_ms=0)
        time.sleep(3.0)
        a = e2e.sample(tab)
        time.sleep(1.2)
        b = e2e.sample(tab)
        sil_ok = bool(a and b and a["mean"] <= 3 and b["mean"] <= 3
                      and abs(a["mean"] - b["mean"]) <= 1)
        tab.close()
        print("%-58s tone:%s(m=%s) silence:%s(a=%s b=%s) %s" % (
            name[:58], "Y" if tone_ok else "n", tone_mean,
            "Y" if sil_ok else "n", a and a["mean"], b and b["mean"],
            "DEFAULT-OK" if (tone_ok and sil_ok) else ""), flush=True)
finally:
    pass
srv.stop()
chrome.close()
