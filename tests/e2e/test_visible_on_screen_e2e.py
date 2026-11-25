"""Screen-level check that the Aura visual is actually composited (L2).

test_viz_e2e.py reads the canvas drawing buffer with gl.readPixels, which is
blind to CSS: a canvas at opacity 0, or one hidden behind another element, still
returns bright pixels. A saved opacity of 0 therefore drew real frames on an
invisible canvas and every assertion still passed.

This module asks the compositor instead. CDP Page.captureScreenshot returns the
PNG the window would show; it is decoded here with the standard library only
(zlib + struct) and the fraction of pixels above a visibility luminance is the
measurement. Cases, all with the tone playing and motion "music":

  * opacity 0.75 (baseline) and opacity 0.0 (the 10% floor) stay visible;
  * intensity 0.0 stays visible;
  * reduced motion stays visible;
  * the Desktop panel's ?overlay=1 page at opacity 0.0 stays visible;
  * ~3 s of silence fades the screen and the next tone brings it back;
  * a sanity test proves the measurement cannot tell a hidden canvas from the
    reference.

"Visible" is relative, never absolute: every case measures a reference in the
same tab at the same moment -- the same page with its canvas forced to CSS
opacity 0 -- and passes only when the normal screen clears that reference by a
margin. The page's own text and controls stay lit at ~1.5-8% of the frame even
with the canvas hidden (measured on SwiftShader), so an absolute bar against
black would fail on a healthy render; the delta over the reference is what the
visual itself adds. Cases that paint a tenth of the buffer are measured at a
cutoff just above --aura-bg's own luminance: at 10% opacity a canvas pixel
would need to be brighter than 123/255 to clear the 24 bar, which a faint floor
is not required to be. lit, dark and lit-dark are printed on every run.

Run: .venv/bin/python -m pytest tests -q
"""
import base64
import json
import struct
import time
import zlib
from collections import namedtuple

import pytest

from test_viz_e2e import (  # same directory; pytest prepends it to sys.path
    Chrome,
    FakeAura,
    aura,
    chrome,
    page_url,
    wait_for,
    wait_ready,
)

TONE_PRESET = "Zylot - True Visionary (Final Mix)"
VIEW_W, VIEW_H = 640, 480
# --aura-bg in index.html, and the dark window the overlay page sits on. An
# alpha-0 screenshot is composited over it; the same colour is pinned over CDP
# so a transparent page still has a deterministic base.
SCREEN_BASE_RGB = (11, 13, 18)
# Visibility bar: luminance 24/255. The page's own backdrop is 12.9, so a black
# stage measures 0 and a healthy render clears it easily.
LIT_LUMINANCE = 24
# The 10% floor paints a tenth of the drawing buffer, so a canvas pixel would
# have to be brighter than ~123/255 to clear 24 once composited. The floor
# cases therefore use a cutoff just above the backdrop (12.9) instead, which
# still measures 0 for a black screen but asks a sane question of a faint one.
FLOOR_LUMINANCE = 18

# Margins: a case passes when the normal screen is lit this much more than the
# same page with its canvas forced to CSS opacity 0. The reference is not black
# -- the page's own text and controls stay lit -- so the delta, not an absolute
# floor, is what says the visual reached the screen. The measured fractions are
# printed on every run.
MIN_LIT_BASELINE = 0.02    # a full-strength canvas has to add this much
MIN_LIT_FLOOR = 0.005      # a tenth-of-the-buffer floor only adds a little
BLACK_DELTA = 0.002        # a hidden canvas must match the reference this closely


# ---------------------------------------------------------------------------
# PNG decode (standard library only)
# ---------------------------------------------------------------------------

def _png_chunks(blob):
    if blob[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError("CDP returned something that is not a PNG")
    pos = 8
    while pos + 8 <= len(blob):
        length, kind = struct.unpack(">I4s", blob[pos:pos + 8])
        yield kind, blob[pos + 8:pos + 8 + length]
        pos += 12 + length  # length + type + data + crc


def _unfilter(raw, width, height, bpp):
    """Undo the per-scanline PNG filters (types 0-4); return the pixel bytes.

    Chrome's encoder chooses the filter per row. These captures are pinned to
    640x480 so this byte-by-byte pass stays cheap.
    """
    stride = width * bpp
    if len(raw) < height * (stride + 1):
        raise AssertionError("PNG image data is short: %d bytes" % len(raw))
    out = bytearray(height * stride)
    prev = -1
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        start = y * stride
        row = bytearray(raw[pos:pos + stride])
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ftype == 2:
            if prev >= 0:
                for i in range(stride):
                    row[i] = (row[i] + out[prev + i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                up = out[prev + i] if prev >= 0 else 0
                row[i] = (row[i] + ((left + up) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                b = out[prev + i] if prev >= 0 else 0
                c = out[prev + i - bpp] if (prev >= 0 and i >= bpp) else 0
                p = a + b - c
                pa = p - a
                if pa < 0:
                    pa = -pa
                pb = p - b
                if pb < 0:
                    pb = -pb
                pc = p - c
                if pc < 0:
                    pc = -pc
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                row[i] = (row[i] + pred) & 0xFF
        else:
            raise AssertionError("unsupported PNG filter type %d on row %d" % (ftype, y))
        out[start:start + stride] = row
        prev = start
    return out


def _decode_png(blob):
    """Return (width, height, channels, pixels) for an 8-bit, non-interlaced PNG."""
    width = height = depth = ctype = interlace = None
    idat = bytearray()
    for kind, body in _png_chunks(blob):
        if kind == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if not width or not height or ctype is None:
        raise AssertionError("PNG has no IHDR")
    if depth != 8 or interlace != 0:
        raise AssertionError("unsupported PNG: depth=%r interlace=%r" % (depth, interlace))
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype)
    if channels is None:
        raise AssertionError("unsupported PNG colour type %r" % (ctype,))
    return width, height, channels, _unfilter(zlib.decompress(bytes(idat)), width, height, channels)


# ---------------------------------------------------------------------------
# what is on screen
# ---------------------------------------------------------------------------

def capture_png(tab):
    """The PNG the window would show, straight from the compositor."""
    result = tab.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
    data = result.get("data")
    if not data:
        raise AssertionError("Page.captureScreenshot returned no image data")
    return base64.b64decode(data)


def screen_lit_fraction(tab, cutoff=LIT_LUMINANCE):
    """Fraction of screen pixels with luminance > cutoff (out of 255).

    A fully transparent capture is composited over --aura-bg rather than
    treated as black alpha: the question is what the window shows, and the
    overlay page paints no background of its own.
    """
    width, height, channels, pixels = _decode_png(capture_png(tab))
    br, bg, bb = SCREEN_BASE_RGB
    lit = 0
    for i in range(0, len(pixels), channels):
        if channels == 4:
            alpha = pixels[i + 3]
            if alpha == 0:
                continue
            if alpha == 255:
                r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
            else:
                inv = 255 - alpha
                r = (pixels[i] * alpha + br * inv) // 255
                g = (pixels[i + 1] * alpha + bg * inv) // 255
                b = (pixels[i + 2] * alpha + bb * inv) // 255
        elif channels == 3:
            r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
        elif channels == 1:
            r = g = b = pixels[i]
        else:  # grey + alpha
            alpha = pixels[i + 1]
            if alpha == 0:
                continue
            inv = 255 - alpha
            r = g = b = (pixels[i] * alpha + br * inv) // 255
        if 0.2126 * r + 0.7152 * g + 0.0722 * b > cutoff:
            lit += 1
    return lit / float(width * height)


def _open_tab(chrome, url):
    """A tab at a pinned 640x480 surface over the app's own backdrop colour.

    The fixed viewport keeps the stdlib PNG decode cheap, and the opaque base
    means a transparent overlay page cannot screenshot as browser white.
    """
    tab = chrome.new_tab("about:blank")
    tab.send("Emulation.setDeviceMetricsOverride", {
        "width": VIEW_W, "height": VIEW_H, "deviceScaleFactor": 1, "mobile": False,
    })
    tab.send("Emulation.setDefaultBackgroundColorOverride", {
        "color": {"r": SCREEN_BASE_RGB[0], "g": SCREEN_BASE_RGB[1],
                  "b": SCREEN_BASE_RGB[2], "a": 1},
    })
    tab.navigate(url)
    return tab


def _wait_for_tone(tab, timeout=30.0):
    """Wait until the page is live on the tone: connected, drawing, not faded."""
    snap = wait_ready(tab)
    assert snap["socketState"] == "connected", snap["socketState"]
    assert snap["canvasAttrs"]["width"] > 0 and snap["canvasAttrs"]["height"] > 0
    snap = wait_for(
        tab, "window.__aura.snapshot()",
        lambda s: bool(s and not s.get("silent") and s.get("frames", 0) > 0
                       and s.get("renderedPcmSeq", 0) > 0),
        timeout=timeout, label="tone-driven frames")
    return snap


def _wait_lit(tab, dark, margin, timeout=15.0, interval=0.5, cutoff=LIT_LUMINANCE):
    """Poll the screen until it is lit `margin` above the hidden-canvas reference.

    `dark` is the same tab with its canvas at CSS opacity 0, so the bar is
    relative: the page chrome is lit either way, and only the delta says the
    visual itself drew.
    """
    deadline = time.time() + timeout
    lit = dark
    while time.time() < deadline:
        lit = screen_lit_fraction(tab, cutoff)
        if lit - dark > margin:
            return lit
        time.sleep(interval)
    raise AssertionError(
        "screen never lit more than %.2f%% above the %.2f%% hidden-canvas "
        "reference at luminance>%d (last %.3f%% lit, delta %.3f%%)"
        % (100 * margin, 100 * dark, cutoff, 100 * lit, 100 * (lit - dark)))


def _hidden_canvas_fraction(tab, cutoff=LIT_LUMINANCE):
    """Lit fraction of this page with its canvas at CSS opacity 0.

    That is the stage the tests compare against, measured in the same tab
    moments before the case, so the comparison never depends on the preset, the
    renderer or the page's own lit chrome. It is not expected to be black.
    """
    painted = tab.ev("getComputedStyle(document.getElementById('aura-canvas')).opacity")
    tab.ev("document.getElementById('aura-canvas').style.opacity = '0'")
    try:
        time.sleep(0.6)  # the canvas opacity transition is 240 ms
        return screen_lit_fraction(tab, cutoff)
    finally:
        tab.ev("document.getElementById('aura-canvas').style.opacity = %s"
               % json.dumps(painted))
        time.sleep(0.6)


# ---------------------------------------------------------------------------
# fixtures: chrome / aura are the real harness from test_viz_e2e.py
# ---------------------------------------------------------------------------

VisualCase = namedtuple(
    "VisualCase", "name opacity intensity reduced overlay silence cutoff min_lit")

VISIBILITY_CASES = [
    VisualCase("opacity 0.75 (baseline)", 0.75, 0.6, False, False, False,
               LIT_LUMINANCE, MIN_LIT_BASELINE),
    VisualCase("opacity 0.0 (10% floor)", 0.0, 0.6, False, False, False,
               FLOOR_LUMINANCE, MIN_LIT_FLOOR),
    VisualCase("intensity 0.0", 0.75, 0.0, False, False, False,
               FLOOR_LUMINANCE, MIN_LIT_FLOOR),
    VisualCase("reduced motion", 0.75, 0.6, True, False, False,
               LIT_LUMINANCE, MIN_LIT_BASELINE),
    VisualCase("overlay, opacity 0.0", 0.0, 0.6, False, True, False,
               FLOOR_LUMINANCE, MIN_LIT_FLOOR),
    VisualCase("silence 3s then tone", 0.75, 0.6, False, False, True,
               LIT_LUMINANCE, MIN_LIT_BASELINE),
]


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("case", VISIBILITY_CASES, ids=[c.name for c in VISIBILITY_CASES])
def test_visual_is_composited_on_screen(chrome, aura, case):
    """The tone must reach the screen in every strength/motion/overlay setting."""
    aura.motion = "music"
    aura.mode = "tone"
    aura.behavior = "balanced"
    aura.auto_preset = False
    aura.preset = TONE_PRESET
    aura.intensity = case.intensity
    aura.opacity = case.opacity

    extra = "&overlay=1" if case.overlay else ""
    if case.reduced:
        # The same force-switch the desktop plugin appends for gentle motion.
        extra += "&reduced-motion=1"
    tab = _open_tab(chrome, page_url(aura.port, extra=extra))
    try:
        snap = _wait_for_tone(tab)
        print("%s: boot preset=%r opacity=%s intensity=%s reducedMotion=%s overlay=%s"
              % (case.name, snap["preset"], snap["opacity"], snap["userIntensity"],
                 snap["reducedMotion"], snap["overlay"]), flush=True)
        # The case has to actually be the case: a setting that never reached the
        # page would make the visibility assertion meaningless.
        assert bool(snap["reducedMotion"]) is case.reduced
        assert bool(snap["overlay"]) is case.overlay
        assert abs(snap["opacity"] - case.opacity) < 0.001
        assert abs(snap["userIntensity"] - case.intensity) < 0.001

        # Let the preset settle at the configured strength before measuring.
        time.sleep(1.0)
        # Reference first (same tab, same moment), then the normal screen: the
        # hidden-canvas fraction is what this page looks like without the
        # visual, and only the excess over it counts as visible.
        dark = _hidden_canvas_fraction(tab, case.cutoff)
        lit = _wait_lit(tab, dark, case.min_lit, cutoff=case.cutoff)
        painted = float(tab.ev(
            "getComputedStyle(document.getElementById('aura-canvas')).opacity"))
        print("%s: lit=%.3f%%, dark=%.3f%% (canvas hidden), lit-dark=%.3f%% of %dx%d "
              "at luminance>%d, canvas CSS opacity %.2f, profile=%s" % (
                  case.name, 100 * lit, 100 * dark, 100 * (lit - dark),
                  VIEW_W, VIEW_H, case.cutoff, painted, snap["behavior"]), flush=True)

        assert painted == pytest.approx(max(case.opacity, 0.1), abs=0.02), (
            "the canvas was painted at opacity %.3f, not the saved %.2f (floor 0.1)"
            % (painted, case.opacity))
        assert lit - dark > case.min_lit, (
            "the visual is not visible on screen: %.3f%% lit, %.3f%% with the "
            "canvas hidden, delta %.3f%% against a %.2f%% margin"
            % (100 * lit, 100 * dark, 100 * (lit - dark), 100 * case.min_lit))

        if not case.silence:
            return

        # The silence fade must clear the screen and must not stick: ~3 s of
        # silence, then the same tone has to bring the visual back.
        aura.mode = "silence"
        wait_for(tab, "window.__aura.snapshot()",
                 lambda s: bool(s and s.get("silent") is True),
                 timeout=10, label="silence fade")
        time.sleep(0.8)  # SILENCE_FADE_MS is 600 ms
        faded = screen_lit_fraction(tab, case.cutoff)
        print("%s: after silence the screen is %.3f%% lit (%.3f%% above the "
              "hidden-canvas reference of %.3f%%)"
              % (case.name, 100 * faded, 100 * (faded - dark), 100 * dark), flush=True)
        assert faded - dark <= BLACK_DELTA, (
            "silence did not clear the screen: %.3f%% lit, %.3f%% above the "
            "hidden-canvas reference" % (100 * faded, 100 * (faded - dark)))

        aura.mode = "tone"
        wait_for(tab, "window.__aura.snapshot()",
                 lambda s: bool(s and s.get("silent") is False
                                and s.get("renderedPcmSeq", 0) > 0),
                 timeout=10, label="resume after silence")
        resumed = _wait_lit(tab, dark, case.min_lit, cutoff=case.cutoff)
        print("%s: after resume the screen is %.3f%% lit, %.3f%% above the "
              "hidden-canvas reference (was %.3f%% lit before resume)"
              % (case.name, 100 * resumed, 100 * (resumed - dark), 100 * faded),
              flush=True)
        assert resumed - dark > case.min_lit, (
            "the silence fade stuck: only %.3f%% of pixels lit, %.3f%% above the "
            "hidden-canvas reference, after the tone returned"
            % (100 * resumed, 100 * (resumed - dark)))
    finally:
        tab.close()


def test_measurement_catches_a_black_screen(chrome, aura):
    """The delta must collapse when nothing is composited.

    Without this every "visible" assertion above could be measuring the page's
    own lit chrome. The reference is measured with the canvas at CSS opacity 0;
    hiding the canvas again has to land back on that same fraction (delta ~0),
    or the excess measured above is not the visual.
    """
    aura.motion = "music"
    aura.mode = "tone"
    aura.behavior = "balanced"
    aura.auto_preset = False
    aura.preset = TONE_PRESET
    tab = _open_tab(chrome, page_url(aura.port))
    try:
        _wait_for_tone(tab)
        time.sleep(1.0)
        dark = _hidden_canvas_fraction(tab)
        lit = _wait_lit(tab, dark, MIN_LIT_BASELINE)
        painted = tab.ev("getComputedStyle(document.getElementById('aura-canvas')).opacity")
        tab.ev("document.getElementById('aura-canvas').style.opacity = '0'")
        time.sleep(0.6)  # the canvas opacity transition is 240 ms
        hidden = screen_lit_fraction(tab)
        print("black-screen check: lit=%.3f%% (canvas painted, opacity %s), "
              "dark=%.3f%% (canvas hidden), lit-dark=%.3f%%, hidden again %.3f%% "
              "(delta %.3f%%)" % (100 * lit, painted, 100 * dark, 100 * (lit - dark),
                                  100 * hidden, 100 * (hidden - dark)), flush=True)
        assert lit - dark > MIN_LIT_BASELINE, (
            "the tone never reached the screen to begin with: delta %.3f%%"
            % (100 * (lit - dark),))
        assert abs(hidden - dark) <= BLACK_DELTA, (
            "hiding the canvas moved the lit fraction from %.3f%% to %.3f%% "
            "(delta %.3f%%): the measurement cannot tell a hidden canvas from "
            "the reference" % (100 * dark, 100 * hidden, 100 * (hidden - dark)))
    finally:
        tab.close()
