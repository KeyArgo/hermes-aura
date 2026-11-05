#!/usr/bin/env python3
"""Evidence capture: real page, real Chrome, 1400x880, one shot per mood.

Saves PNGs to .shots/ and prints the probe metrics (coverage = fraction of
pixels luma>16; colour = std dev of saturation on lit pixels; hueEnt = hue
histogram entropy) measured from the live canvas at shot time.
"""
import base64
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from probe_presets import PROBE_JS  # noqa: E402
import test_viz_e2e as e2e  # noqa: E402

SHOTS = Path("/mnt/homes/Development/hermes-aura/.lanes/L5/.shots")
SHOTS.mkdir(exist_ok=True)

srv = e2e.FakeAura()
srv.start()
chrome = e2e.Chrome()
tab = chrome.new_tab(e2e.page_url(srv.port))
srv.mode = "tone"
e2e.wait_ready(tab, timeout=40)
tab.send("Emulation.setDeviceMetricsOverride", {
    "width": 1400, "height": 880, "deviceScaleFactor": 1, "mobile": False})
time.sleep(1.0)

def shot(name):
    data = tab.send("Page.captureScreenshot", {"format": "png"})
    path = SHOTS / name
    path.write_bytes(base64.b64decode(data["data"]))
    m = tab.ev(PROBE_JS)
    m["file"] = str(path)
    print(json.dumps(m), flush=True)

# 1. idle + tone: the default preset, no mood overlay
e2e.wait_lit(tab, 0.10, timeout=20)
time.sleep(1.0)
shot("1-idle-tone.png")

# 2. thinking: mood engine blends to a geometric/fractal preset, saturate/contrast lift
srv.send_mood("thinking", intensity=0.7, ttl_ms=30000)
e2e.expect_mood(tab, "thinking", timeout=6)
time.sleep(4.0)  # blend 2.2 s + settle
shot("2-thinking.png")

# 3. approval: cosmic/geometric + contrast 1.14 + attention pulse
srv.send_mood("approval", intensity=0.85, ttl_ms=30000)
e2e.expect_mood(tab, "approval", timeout=6)
time.sleep(2.0)
shot("3-approval.png")

# 4. error: liquid/cosmic under the red settle tint
srv.send_mood("error", intensity=0.8, ttl_ms=30000)
e2e.expect_mood(tab, "error", timeout=6)
time.sleep(2.0)
shot("4-error.png")

snap = e2e.snapshot(tab)
print("final state: preset=%s mood=%s errors=%s flashMax=%d" % (
    snap["preset"], snap["mood"], snap["errors"], snap["flash"]["maxPerSecond"]), flush=True)

tab.close()
srv.stop()
chrome.close()
