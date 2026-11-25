"""Live regression test for WebGL context loss and recovery (L2).

Losing a context invalidates every program, buffer and texture the Butterchurn
visualizer built. The vendored renderer has no restoration handler of its own,
and its resize path only reallocates when the target size changes — so handing
the same, now-dead instance back to the render loop after `webglcontextrestored`
leaves the page drawing nothing. The only way back to real frames is a new
visualizer built on the restored context.

The assertion is measured pixels, not a frame counter: the loop happily keeps
calling render() on the dead instance, so `frames` grows while the canvas stays
black. The context is lost and restored at the same size so a resize cannot
stand in for resource creation.

Reuses the real page + fake Aura server + muted Chrome harness from
test_viz_e2e.py.

Run: .venv/bin/python -m pytest tests -q
"""
import time

import pytest

from test_viz_e2e import (  # same directory; pytest prepends it to sys.path
    Chrome,
    FakeAura,
    page_url,
    sample,
    snapshot,
    wait_for,
    wait_lit,
    wait_ready,
)

BRIGHT_PRESET = "Zylot - True Visionary (Final Mix)"


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


LOSE_CONTEXT_JS = """
(() => {
  const canvas = document.getElementById('aura-canvas');
  const gl = canvas && canvas.getContext('webgl2');
  if (!gl) return 'no-context';
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return 'no-extension';
  window.__auraLoseContext = ext;
  ext.loseContext();
  return 'lost';
})()
"""

RESTORE_CONTEXT_JS = """
(() => {
  const ext = window.__auraLoseContext;
  if (!ext) return 'no-extension';
  ext.restoreContext();
  return 'restoring';
})()
"""


def lit_fraction(sample_row):
    return sample_row["lit"] / float((sample_row["w"] * sample_row["h"]) // 4)


def test_restored_context_renders_live_frames(chrome, aura):
    aura.motion = "music"
    tab = chrome.new_tab(page_url(aura.port))
    try:
        wait_ready(tab)
        aura.auto_preset = False
        aura.preset = BRIGHT_PRESET
        aura.send_config()
        time.sleep(1.2)
        aura.mode = "tone"
        before = wait_lit(tab, 0.08, timeout=15)
        base = snapshot(tab)
        print("before loss: mean=%d lit=%d/%d preset=%s canvas=%s" % (
            before["mean"], before["lit"], (before["w"] * before["h"]) // 4,
            base["preset"], base["canvas"]), flush=True)
        assert base["fallbackActive"] is False
        css_size = (base["canvas"]["cssW"], base["canvas"]["cssH"])

        assert tab.ev(LOSE_CONTEXT_JS) == "lost", "WEBGL_lose_context unavailable"
        lost = wait_for(tab, "window.__aura.snapshot()",
                        lambda s: bool(s and s.get("fallbackActive")
                                       and "webgl" in (s.get("fallbackReasons") or [])),
                        timeout=10, label="lost-context fallback")
        print("context lost: reasons=%s" % (lost["fallbackReasons"],), flush=True)

        # Same stage box as before the loss: recovery must rebuild resources,
        # not lean on the resize path.
        assert (lost["canvas"]["cssW"], lost["canvas"]["cssH"]) == css_size

        assert tab.ev(RESTORE_CONTEXT_JS) == "restoring", "restoreContext failed"
        restored = wait_for(tab, "window.__aura.snapshot()",
                            lambda s: bool(s and not s.get("fallbackActive")),
                            timeout=20, label="fallback cleared after restore")
        print("context restored: reasons=%s canvas=%s" % (
            restored["fallbackReasons"], restored["canvas"]), flush=True)

        first = wait_for(tab, "window.__aura.sampleNow()",
                         lambda s: bool(s and s.get("mean", 0) > 2
                                        and s.get("lit", 0) > 0.05 * (s["w"] * s["h"] // 4)),
                         timeout=15, label="live frame after restore")
        time.sleep(1.0)
        second = sample(tab)
        print("after restore: mean=%d lit=%d hash=%d -> mean=%d lit=%d hash=%d" % (
            first["mean"], first["lit"], first["hash"],
            second["mean"], second["lit"], second["hash"] if second else -1), flush=True)
        assert second is not None, "no pixel sample after the context came back"
        assert second["mean"] > 2 and lit_fraction(second) > 0.05, \
            "restored canvas draws black: %s" % (second,)
        assert second["hash"] != first["hash"], \
            "restored canvas is frozen: %s -> %s" % (first["hash"], second["hash"])

        frames = snapshot(tab)["frames"]
        time.sleep(0.8)
        assert snapshot(tab)["frames"] > frames, "render loop did not resume"
    finally:
        tab.close()
