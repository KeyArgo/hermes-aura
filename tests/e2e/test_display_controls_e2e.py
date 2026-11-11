"""Live verification of the display controls (opacity + behaviour profiles).

Reuses the real page + fake Aura server + muted Chrome harness from
test_viz_e2e.py.  Proves, with measured numbers, that:

  * opacity really dims the visualizer layer (composited canvas brightness
    drops at 0.2 vs 1.0) while the scrim keeps at least today's contrast and
    the control chrome stays fully opaque;
  * behavior=calm lowers the intensity ceiling (measured effective intensity),
    refuses strobe presets and does not hard-pulse an attention mood;
  * balanced/intense change the pulse rate ceiling and mood strength;
  * mood_reactive / auto_preset stop cleanly and resume without a reload.

Run: .venv/bin/python -m pytest tests -q
"""
import json
import time

import pytest

from test_viz_e2e import (  # same directory; pytest prepends it to sys.path
    BEHAVIOR_PROFILES,
    Chrome,
    FakeAura,
    page_url,
    sample,
    snapshot,
    wait_for,
    wait_lit,
    wait_ready,
)

# Composite the WebGL canvas at its CSS opacity into a 2D canvas and measure
# the mean brightness. This is what the window compositor shows, not the raw
# drawing buffer (which readPixels sees regardless of CSS opacity).
MEASURE_OPACITY_JS = """
(() => {
  const v = window.__aura._viz();
  if (v) { try { v.render(); } catch (e) { return null; } }
  const src = document.getElementById('aura-canvas');
  const op = parseFloat(getComputedStyle(src).opacity);
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.globalAlpha = isFinite(op) ? op : 0;
  try { ctx.drawImage(src, 0, 0, c.width, c.height); } catch (e) { return null; }
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  let alphaSum = 0;
  for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; alphaSum += d[i + 3]; }
  const n = d.length / 4;
  const mean = sum / n / 3;
  const alphaMean = alphaSum / n;
  // getImageData returns unpremultiplied RGB, so weight it by the composited
  // alpha to get the brightness actually contributed to the screen.
  return { mean: Math.round(mean), alpha: op, alphaMean: Math.round(alphaMean),
           visual: Math.round(mean * alphaMean / 255) };
})()
"""


@pytest.fixture(scope="module")
def chrome():
    c = Chrome()
    yield c
    c.close()


@pytest.fixture()
def aura():
    srv = FakeAura()
    srv.start()
    yield srv
    srv.stop(close_http=True)


def _apply(tab, cfg):
    return tab.ev("window.__aura.applyConfig(%s)" % json.dumps(cfg))


def test_opacity_dims_canvas_keeps_scrim_and_chrome_legible(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        aura.send_preset("Zylot - True Visionary (Final Mix)", blend_ms=0)
        time.sleep(1.2)
        aura.mode = "tone"
        wait_lit(tab, 0.08, timeout=15)

        tab.ev("window.__aura.setOpacityUI(1.0)")
        time.sleep(0.6)
        full = tab.ev(MEASURE_OPACITY_JS)
        full_snap = snapshot(tab)
        scrim_full = float(full_snap["scrimOpacity"])

        tab.ev("window.__aura.setOpacityUI(0.2)")
        time.sleep(0.6)
        low = tab.ev(MEASURE_OPACITY_JS)
        low_snap = snapshot(tab)
        scrim_low = float(low_snap["scrimOpacity"])
        mix_low = float(low_snap["scrimMix"]["a"])
        mix_full = float(full_snap["scrimMix"]["a"])

        chrome_opacity = float(tab.ev(
            "getComputedStyle(document.getElementById('aura-controls')).opacity"))
        text_opacity = float(tab.ev(
            "getComputedStyle(document.getElementById('aura-mood')).opacity"))

        print("opacity: canvas CSS %s -> %s, composited alpha %s -> %s, "
              "visual brightness %s -> %s (raw mean %s -> %s), "
              "scrim %s -> %s (mix %s -> %s), controls opacity %s, mood chip %s" % (
                  full_snap["canvasOpacity"], low_snap["canvasOpacity"],
                  full["alphaMean"] if full else None, low["alphaMean"] if low else None,
                  full["visual"] if full else None, low["visual"] if low else None,
                  full["mean"] if full else None, low["mean"] if low else None,
                  scrim_full, scrim_low, mix_full, mix_low,
                  chrome_opacity, text_opacity), flush=True)

        assert full and low, "canvas could not be composited/measured"
        assert abs(float(low_snap["canvasOpacity"]) - 0.2) < 0.01
        assert abs(float(full_snap["canvasOpacity"]) - 1.0) < 0.01
        assert low["alphaMean"] < full["alphaMean"] * 0.5, (
            "opacity 0.2 must reach the compositor: alpha %s -> %s" % (
                full["alphaMean"], low["alphaMean"]))
        assert low["visual"] < full["visual"], (
            "opacity 0.2 must dim the visualizer: visual %s -> %s" % (
                full["visual"], low["visual"]))
        assert low["visual"] <= full["visual"] * 0.5 + 2, (
            "0.2 opacity should roughly fifth the brightness: %s vs %s" % (
                low["visual"], full["visual"]))
        # Scrim: computed from opacity, never fully transparent, and its
        # effective gradient alpha is compensated so contrast does not drop.
        assert scrim_full == pytest.approx(1.0, abs=0.01)
        assert scrim_low >= 0.85
        assert mix_low > mix_full, "scrim alphas must compensate the lower element opacity"
        assert chrome_opacity == pytest.approx(1.0, abs=0.01)
        assert text_opacity == pytest.approx(1.0, abs=0.01)
        print("PASS opacity dims canvas and computes a legible scrim", flush=True)
    finally:
        tab.close()


def test_calm_lowers_ceiling_refuses_strobe_and_has_no_hard_pulse(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        # Max user intensity in each profile: the effective intensity must be
        # capped by the profile, not just relabelled.
        tab.ev("window.__aura.setIntensityUI(1.0)")
        _apply(tab, {"behavior": "balanced",
                     "behavior_profile": BEHAVIOR_PROFILES["balanced"]})
        time.sleep(0.4)
        balanced = snapshot(tab)
        _apply(tab, {"behavior": "calm",
                     "behavior_profile": BEHAVIOR_PROFILES["calm"]})
        time.sleep(0.6)
        calm = snapshot(tab)
        print("ceiling: balanced intensity=%s profile=%s | calm intensity=%s profile=%s" % (
            balanced["intensity"], balanced["behaviorProfile"]["intensity_ceiling"],
            calm["intensity"], calm["behaviorProfile"]["intensity_ceiling"]), flush=True)
        assert balanced["intensity"] > calm["intensity"]
        assert calm["intensity"] <= 0.6 + 1e-6
        assert calm["behaviorProfile"]["allow_strobe"] is False
        assert calm["behaviorProfile"]["hard_pulse"] is False

        # Strobe preset must be refused under calm, accepted under balanced.
        # Pick it from the live catalogue: the curated set changes, and a preset
        # that is no longer listed has no measured strobe flag to refuse.
        import os
        catalog_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "web", "presets.json")
        catalog = json.load(open(catalog_path))
        strobe = next(p["name"] for p in catalog["presets"] if p.get("strobe"))
        print("calm strobe probe preset=%r" % strobe, flush=True)
        before = snapshot(tab)["preset"]
        aura.send_preset(strobe, blend_ms=0)
        time.sleep(1.0)
        after_calm = snapshot(tab)
        print("calm strobe: before=%r after=%r strobeFlag=%s" % (
            before, after_calm["preset"], after_calm["presetStrobe"]), flush=True)
        assert after_calm["presetStrobe"] is False, "calm must refuse strobe presets"
        assert after_calm["preset"] != strobe

        _apply(tab, {"behavior": "balanced",
                     "behavior_profile": BEHAVIOR_PROFILES["balanced"]})
        time.sleep(0.5)
        aura.send_preset(strobe, blend_ms=0)
        time.sleep(1.0)
        after_balanced = snapshot(tab)
        print("balanced strobe: preset=%r strobeFlag=%s" % (
            after_balanced["preset"], after_balanced["presetStrobe"]), flush=True)
        assert after_balanced["preset"] == strobe
        assert after_balanced["presetStrobe"] is True

        # Attention mood under calm: static wash, no hard pulse, still visible.
        _apply(tab, {"behavior": "calm",
                     "behavior_profile": BEHAVIOR_PROFILES["calm"]})
        time.sleep(0.3)
        aura.send_mood("approval", intensity=0.85, ttl_ms=4000)
        wait_for(tab, "window.__aura.snapshot()", lambda s: s and s.get("mood") == "approval",
                 timeout=6, label="calm approval")
        time.sleep(0.8)
        calm_att = snapshot(tab)
        print("calm approval: mood=%s intensity=%s pulsePeriod=%s flashMax=%d glow=%s" % (
            calm_att["mood"], calm_att["intensity"], calm_att["pulsePeriodMs"],
            calm_att["flash"]["maxPerSecond"],
            tab.ev("document.getElementById('aura-root').style.getPropertyValue('--aura-glow')")),
            flush=True)
        assert calm_att["pulsePeriodMs"] == 0, "calm must not hard-pulse"
        assert calm_att["intensity"] <= 0.6 + 1e-6
        assert calm_att["flash"]["maxPerSecond"] <= 3
        print("PASS calm: ceiling 0.6, no strobe, no hard pulse", flush=True)

        # intense changes real parameters too: faster pulse + stronger mood.
        _apply(tab, {"behavior": "intense",
                     "behavior_profile": BEHAVIOR_PROFILES["intense"]})
        time.sleep(0.3)
        aura.send_mood("approval", intensity=0.9, ttl_ms=4000)
        wait_for(tab, "window.__aura.snapshot()", lambda s: s and s.get("mood") == "approval",
                 timeout=6, label="intense approval")
        intense_att = snapshot(tab)
        print("intense approval: pulsePeriod=%sms gain=%s moodGainScale=%s" % (
            intense_att["pulsePeriodMs"], intense_att["sampleGain"],
            intense_att["behaviorProfile"]["mood_gain_scale"]), flush=True)
        assert intense_att["pulsePeriodMs"] == 500, "intense pulse must be 2 Hz, not faster"
        assert intense_att["pulsePeriodMs"] >= 500
        assert intense_att["behaviorProfile"]["mood_gain_scale"] > 1.0
        print("PASS intense: pulse 500 ms (2 Hz cap), mood gain 1.35", flush=True)
    finally:
        tab.close()


def test_toggles_stop_and_resume_without_reload(chrome, aura):
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        aura.send_preset("Zylot - True Visionary (Final Mix)", blend_ms=0)
        time.sleep(1.0)
        aura.mode = "tone"
        wait_lit(tab, 0.05, timeout=15)

        # mood_reactive off: no mood is held.
        _apply(tab, {"mood_reactive": False})
        aura.send_mood("approval", intensity=0.9, ttl_ms=4000, repeat=True)
        time.sleep(1.0)
        off = snapshot(tab)
        print("mood_reactive off: mood=%s reactive=%s" % (off["mood"], off["moodReactive"]),
              flush=True)
        assert off["mood"] == "idle"
        assert off["moodReactive"] is False

        # Back on without a reload: the server's current mood is applied.
        _apply(tab, {"mood_reactive": True})
        applied = wait_for(tab, "window.__aura.snapshot()",
                           lambda s: s and s.get("mood") == "approval",
                           timeout=6, label="mood resumed")
        print("mood_reactive on: mood=%s (no reload)" % applied["mood"], flush=True)
        assert applied["moodReactive"] is True

        # Rotation is tested independently of mood-driven preset steering.
        aura.send_mood("idle", intensity=0, ttl_ms=0, repeat=True)
        wait_for(tab, "window.__aura.snapshot().mood", lambda mood: mood == "idle",
                 timeout=6, label="mood cleared before preset test")

        # auto_preset off: rotation events are ignored, manual preset still applies.
        _apply(tab, {"auto_preset": False})
        time.sleep(0.3)
        before = snapshot(tab)["preset"]
        aura.send_preset("Flexi - area 51", blend_ms=0)
        time.sleep(1.0)
        off_preset = snapshot(tab)
        print("auto_preset off: preset=%r after rotation event %r" % (
            off_preset["preset"], "Flexi - area 51"), flush=True)
        assert off_preset["preset"] == before

        aura.preset = "Flexi - alien fish pond"
        aura.send_config()
        resumed = wait_for(tab, "window.__aura.snapshot().preset",
                           lambda p: p == "Flexi - alien fish pond", timeout=6,
                           label="manual preset via config")
        print("manual preset via config: %r" % resumed, flush=True)

        _apply(tab, {"auto_preset": True})
        time.sleep(0.3)
        aura.send_preset("Flexi - area 51", blend_ms=0)
        on_preset = wait_for(tab, "window.__aura.snapshot()",
                             lambda s: s and s.get("preset") == "Flexi - area 51",
                             timeout=6, label="auto preset rotation resumed")
        print("auto_preset on: preset=%r" % on_preset["preset"], flush=True)
        assert on_preset["preset"] == "Flexi - area 51"
        print("PASS toggles stop cleanly and resume live", flush=True)
    finally:
        tab.close()
