"""Analysis tests: band placement, silence, onset, determinism, scale.

The FFT is hand-written on purpose (no numpy in shipped code), so these tests
also pin the numeric behaviour of that implementation.
"""

from __future__ import annotations

import math
import struct

import pytest

from aura_core import analysis


def pcm(values) -> bytes:
    return struct.pack(f"<{len(values)}f", *[float(v) for v in values])


def sine(freq: float, amp: float = 0.5, n: int = 1024, phase: float = 0.0):
    return [amp * math.sin(2 * math.pi * freq * i / 48000 + phase) for i in range(n)]


def feed(analyser, samples, ts_ms, count=1):
    result = None
    for i in range(count):
        result = analyser.analyse(samples, ts_ms=ts_ms + i * 100)
    return result


# ---------------------------------------------------------------------------
# band placement
# ---------------------------------------------------------------------------

def test_1khz_sine_lands_in_1k_band_not_8k():
    analyser = analysis.Analyser()
    result = feed(analyser, pcm(sine(1000.0)), ts_ms=0, count=6)
    bands = result["bands"]
    assert len(bands) == 8
    hit = max(range(8), key=lambda i: bands[i])
    assert hit == 4, f"1 kHz sine landed in band {hit}: {bands}"
    assert bands[4] > bands[7] * 5, bands
    assert bands[4] > 0.2
    assert 0.5 < result["level"] <= 1.0
    assert result["centroid"] < 0.1


def test_8khz_sine_lands_in_8k_band():
    analyser = analysis.Analyser()
    result = feed(analyser, pcm(sine(8000.0)), ts_ms=0, count=6)
    bands = result["bands"]
    hit = max(range(8), key=lambda i: bands[i])
    assert hit == 7, f"8 kHz sine landed in band {hit}: {bands}"
    assert bands[7] > bands[4]


def test_63hz_sine_lands_in_lowest_band():
    analyser = analysis.Analyser()
    result = feed(analyser, pcm(sine(63.0)), ts_ms=0, count=6)
    hit = max(range(8), key=lambda i: result["bands"][i])
    assert hit == 0, result["bands"]


def test_band_agc_keeps_quiet_passage_moving():
    loud = analysis.Analyser()
    feed(loud, pcm(sine(1000.0, amp=0.8)), ts_ms=0, count=10)
    loud_band = loud.analyse(pcm(sine(1000.0, amp=0.8)), ts_ms=1000)["bands"][4]

    quiet = analysis.Analyser()
    feed(quiet, pcm(sine(1000.0, amp=0.8)), ts_ms=0, count=10)
    quiet_band = feed(quiet, pcm(sine(1000.0, amp=0.01)), ts_ms=1000, count=15)["bands"][4]

    # The quiet passage is 38 dB down but the slow AGC must still show movement.
    assert quiet_band > 0.05, quiet_band
    assert quiet_band != pytest.approx(loud_band, abs=1e-6)


# ---------------------------------------------------------------------------
# silence
# ---------------------------------------------------------------------------

def test_silence_flag_requires_300ms_and_stays_silent():
    analyser = analysis.Analyser()
    zeros = b"\x00" * 4096
    first = analyser.analyse(zeros, ts_ms=0)
    assert first["silence"] is False
    assert first["level"] == 0.0
    assert all(b == 0.0 for b in first["bands"])

    assert analyser.analyse(zeros, ts_ms=250)["silence"] is False
    assert analyser.analyse(zeros, ts_ms=301)["silence"] is True
    later = analyser.analyse(zeros, ts_ms=900)
    assert later["silence"] is True
    assert later["level"] == 0.0
    assert later["onset"] is False


def test_loud_signal_clears_silence():
    analyser = analysis.Analyser()
    zeros = b"\x00" * 4096
    analyser.analyse(zeros, ts_ms=0)
    analyser.analyse(zeros, ts_ms=400)
    loud = analyser.analyse(pcm(sine(1000.0, amp=0.5)), ts_ms=500)
    assert loud["silence"] is False
    assert loud["level"] > 0.5


# ---------------------------------------------------------------------------
# per-PCM-frame silence (FrameSilence)
# ---------------------------------------------------------------------------

FRAME_MS = 1000.0 * analysis.FFT_SIZE / analysis.SAMPLE_RATE
ZEROS = b"\x00" * (4 * analysis.FFT_SIZE)


def test_frame_rms_matches_a_plain_python_reference():
    values = sine(1000.0, amp=0.5)
    expected = math.sqrt(sum(v * v for v in values) / len(values))
    assert analysis.frame_rms(pcm(values)) == pytest.approx(expected, rel=1e-6)
    assert analysis.frame_rms(values) == pytest.approx(expected, rel=1e-6)
    assert analysis.frame_rms(b"") == 0.0
    assert analysis.frame_rms(b"\x00\x00\x00") == 0.0


def test_frame_rms_survives_nan_and_inf():
    bad = struct.pack("<3f", float("nan"), float("inf"), 0.5)
    assert analysis.level_from_rms(analysis.frame_rms(bad)) == 0.0


def test_tone_frame_right_after_start_is_not_silent():
    # The bug this guards: this flag used to come from the ~10 Hz features
    # pump, which starts silent — real audio was flagged silent at startup.
    tracker = analysis.FrameSilence()
    assert tracker.is_silent(pcm(sine(440.0, amp=0.5)), ts_ms=0) is False


def test_zero_frame_is_silent_from_the_start():
    tracker = analysis.FrameSilence()
    assert tracker.is_silent(ZEROS, ts_ms=0) is True
    assert tracker.is_silent(ZEROS, ts_ms=1000) is True


def test_tone_after_quiet_passage_is_not_flagged_silent():
    tracker = analysis.FrameSilence()
    for i in range(50):
        assert tracker.is_silent(ZEROS, ts_ms=i * FRAME_MS) is True
    assert tracker.is_silent(pcm(sine(1000.0, amp=0.4)), ts_ms=50 * FRAME_MS) is False


def test_hold_prevents_flicker_on_one_quiet_frame_inside_music():
    tracker = analysis.FrameSilence()
    tone = pcm(sine(1000.0, amp=0.5))
    flags = [tracker.is_silent(ZEROS if i == 20 else tone, ts_ms=i * FRAME_MS)
             for i in range(40)]
    assert not any(flags), flags  # the lone drop inside music never flips it

    # Sustained quiet does flip the flag, but only once the hold expired.
    flipped = next((i for i in range(40, 70)
                    if tracker.is_silent(ZEROS, ts_ms=i * FRAME_MS)), None)
    assert flipped is not None, "hold never expired"
    assert (flipped - 39) * FRAME_MS > tracker.hold_ms
    assert (flipped - 1 - 39) * FRAME_MS <= tracker.hold_ms


def test_frame_silence_reset_clears_hold():
    tracker = analysis.FrameSilence()
    tracker.is_silent(pcm(sine(1000.0, amp=0.5)), ts_ms=0)
    tracker.reset()
    assert tracker.is_silent(ZEROS, ts_ms=10) is True


# ---------------------------------------------------------------------------
# onset
# ---------------------------------------------------------------------------

def test_onset_fires_on_click_after_silence():
    analyser = analysis.Analyser()
    zeros = b"\x00" * 4096
    analyser.analyse(zeros, ts_ms=0)
    analyser.analyse(zeros, ts_ms=100)

    click = [0.0] * 1024
    click[512] = 0.9   # centre of the Hann window, so the impulse survives windowing
    click[513] = -0.7
    result = analyser.analyse(pcm(click), ts_ms=200)
    assert result["onset"] is True
    assert result["level"] > 0.2
    assert result["flatness"] > 0.0


def test_onset_does_not_fire_on_steady_sine():
    analyser = analysis.Analyser()
    frame = pcm(sine(440.0))
    analyser.analyse(frame, ts_ms=0)  # first frame may fire: transition from silence
    steady = [analyser.analyse(frame, ts_ms=200 + i * 100) for i in range(8)]
    assert not any(r["onset"] for r in steady), [r["onset"] for r in steady]


def test_onset_refractory_period():
    analyser = analysis.Analyser()
    click = [0.0] * 1024
    click[512] = 1.0
    analyser.analyse(pcm(click), ts_ms=0)
    # Immediately after, a second loud transient inside 80 ms is suppressed.
    analyser.analyse(b"\x00" * 4096, ts_ms=10)
    again = analyser.analyse(pcm(click), ts_ms=20)
    assert again["onset"] is False


# ---------------------------------------------------------------------------
# shape / scale / robustness
# ---------------------------------------------------------------------------

def test_feature_dict_has_exactly_the_contract_keys():
    result = analysis.Analyser().analyse(pcm(sine(1000.0)), ts_ms=0)
    assert set(result) == set(analysis.FEATURE_KEYS)
    assert isinstance(result["onset"], bool)
    assert isinstance(result["silence"], bool)
    assert 0.0 <= result["level"] <= 1.0
    assert 0.0 <= result["centroid"] <= 1.0
    assert 0.0 <= result["flatness"] <= 1.0
    for value in result["bands"]:
        assert 0.0 <= value <= 1.0


def test_level_maps_minus60_dbfs_to_zero():
    # RMS 0.001 is -60 dBFS -> level 0
    analyser = analysis.Analyser()
    dc = [0.001] * 1024
    assert analyser.analyse(pcm(dc), ts_ms=0)["level"] == pytest.approx(0.0, abs=1e-6)
    # RMS 0.5 is about -6 dBFS -> ~0.9
    result = analysis.Analyser().analyse(pcm(sine(1000.0, amp=0.7071)), ts_ms=0)
    assert result["level"] == pytest.approx(0.9, abs=0.02)


def test_deterministic_same_input_same_output():
    frames = [
        (pcm(sine(1000.0)), 0),
        (pcm(sine(500.0, amp=0.2)), 100),
        (b"\x00" * 4096, 200),
        (pcm(sine(4000.0, amp=0.9)), 300),
    ]
    first = analysis.Analyser()
    second = analysis.Analyser()
    out_a = [first.analyse(f, ts_ms=t) for f, t in frames]
    out_b = [second.analyse(f, ts_ms=t) for f, t in frames]
    assert out_a == out_b


def test_survives_empty_and_bad_input():
    analyser = analysis.Analyser()
    assert analyser.analyse(b"", ts_ms=0)["level"] == 0.0
    assert analyser.analyse(b"\x00\x01", ts_ms=100)["level"] == 0.0
    assert analyser.analyse([0.0] * 10, ts_ms=200)["level"] == 0.0
    assert analyser.analyse(None, ts_ms=300)["level"] == 0.0
    nan_frame = pcm([float("nan")] * 1024)
    result = analyser.analyse(nan_frame, ts_ms=400)
    assert math.isfinite(result["level"])


def test_silence_features_helper():
    silent = analysis.silence_features()
    assert silent["silence"] is True
    assert silent["level"] == 0.0
    assert silent["bands"] == [0.0] * 8


def test_fft_matches_direct_dft_on_small_case():
    n = 8
    signal = [math.sin(2 * math.pi * 2 * i / n) for i in range(n)]
    re = list(signal)
    im = [0.0] * n
    analysis.fft(re, im)
    # Bin 2 should dominate (and bin n-2 mirror); compare against a direct DFT.
    direct = []
    for k in range(n):
        sr = sum(signal[j] * math.cos(-2 * math.pi * k * j / n) for j in range(n))
        si = sum(signal[j] * math.sin(-2 * math.pi * k * j / n) for j in range(n))
        direct.append(math.hypot(sr, si))
    got = [math.hypot(re[k], im[k]) for k in range(n)]
    for k in range(n):
        assert got[k] == pytest.approx(direct[k], abs=1e-9)
    assert max(range(n), key=lambda k: got[k]) == 2
