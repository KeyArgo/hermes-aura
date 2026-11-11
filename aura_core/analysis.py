"""Local audio analysis: stdlib only, deterministic, unit-testable.

Produces exactly the feature frame described in CONTRACT.md §3::

    {"level": 0..1, "bands": [8 floats], "onset": bool,
     "centroid": 0..1, "flatness": 0..1, "silence": bool}

``level`` is RMS on a −60..0 dBFS scale. ``bands`` are 63/125/250/500/1k/2k/
4k/8k Hz octave bands, each divided by a slow per-band AGC envelope so quiet
passages still produce visible movement. The spectrum comes from a hand-written
iterative radix-2 Cooley–Tukey FFT over 1024 Hann-windowed samples — no numpy,
no native code.

Nothing is stored on disk; an :class:`Analyser` keeps its AGC/onset state in
memory and is safe to reuse for a stream. All times are supplied by the caller
so behaviour is reproducible in tests.
"""

from __future__ import annotations

import math
import struct

SAMPLE_RATE = 48000
FFT_SIZE = 1024
BAND_CENTERS = (63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0)

SILENCE_LEVEL = 0.02
SILENCE_MS = 300.0
FRAME_SILENCE_HOLD_MS = 250.0  # per-PCM-frame anti-flicker hold
ONSET_THRESHOLD = 0.28
ONSET_REFRACTORY_MS = 80.0
AGC_FLOOR = 1e-6
AGC_DECAY = 0.75
AGC_ADAPT = 0.2

FEATURE_KEYS = ("level", "bands", "onset", "centroid", "flatness", "silence")


# ---------------------------------------------------------------------------
# FFT
# ---------------------------------------------------------------------------

def _hann(n: int) -> list[float]:
    return [0.5 * (1.0 - math.cos(2.0 * math.pi * i / (n - 1))) for i in range(n)]


_HANN = _hann(FFT_SIZE)


def fft(re: list[float], im: list[float]) -> None:
    """In-place iterative radix-2 FFT (forward, e^{-i…}). Length must be 2^k."""
    n = len(re)
    if n != len(im) or n < 2 or (n & (n - 1)):
        raise ValueError("fft length must be a power of two")
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    size = 2
    while size <= n:
        half = size >> 1
        angle = -2.0 * math.pi / size
        wlen_re = math.cos(angle)
        wlen_im = math.sin(angle)
        for start in range(0, n, size):
            wr = 1.0
            wi = 0.0
            for k in range(half):
                a = start + k
                b = a + half
                vr = re[b] * wr - im[b] * wi
                vi = re[b] * wi + im[b] * wr
                ur = re[a]
                ui = im[a]
                re[a] = ur + vr
                im[a] = ui + vi
                re[b] = ur - vr
                im[b] = ui - vi
                wr, wi = wr * wlen_re - wi * wlen_im, wr * wlen_im + wi * wlen_re
        size <<= 1


def magnitude_spectrum(samples) -> list[float]:
    """Magnitude of bins 0..N/2 for 1024 float samples (windowed, scaled)."""
    n = FFT_SIZE
    values = _coerce(samples)
    if len(values) < n:
        values = values + [0.0] * (n - len(values))
    re = [values[i] * _HANN[i] for i in range(n)]
    im = [0.0] * n
    fft(re, im)
    scale = 2.0 / n
    mags = [0.0] * (n // 2 + 1)
    for k in range(n // 2 + 1):
        mags[k] = math.hypot(re[k], im[k]) * scale
    return mags


def _coerce(samples) -> list[float]:
    """Accept bytes (float32 LE) or any numeric sequence; clamp to [-1, 1]."""
    if samples is None:
        return [0.0] * FFT_SIZE
    if isinstance(samples, (bytes, bytearray, memoryview)):
        raw = bytes(samples)
        count = len(raw) // 4
        if count == 0:
            return [0.0] * FFT_SIZE
        vals = struct.unpack(f"<{count}f", raw[: count * 4])
        out = []
        for v in vals:
            if v != v or v in (float("inf"), float("-inf")):  # NaN/inf guard
                out.append(0.0)
            else:
                out.append(max(-1.0, min(1.0, v)))
        return out
    try:
        out = []
        for v in samples:
            f = float(v)
            if f != f:
                f = 0.0
            out.append(max(-1.0, min(1.0, f)))
        return out
    except (TypeError, ValueError):
        return [0.0] * FFT_SIZE


def _band_bins(sample_rate: int, n: int) -> list[tuple[int, int]]:
    """Bin ranges for the eight octave bands, clamped to valid bins."""
    df = sample_rate / float(n)
    out = []
    for center in BAND_CENTERS:
        lo = center / math.sqrt(2.0)
        hi = center * math.sqrt(2.0)
        lo_bin = max(1, int(math.floor(lo / df)))
        hi_bin = min(n // 2 - 1, int(math.ceil(hi / df)))
        if hi_bin < lo_bin:
            hi_bin = lo_bin
        out.append((lo_bin, hi_bin))
    return out


_BANDS = _band_bins(SAMPLE_RATE, FFT_SIZE)


def _rms(values: list[float]) -> float:
    if not values:
        return 0.0
    total = 0.0
    for v in values:
        total += v * v
    return math.sqrt(total / len(values))


def level_from_rms(rms: float) -> float:
    """RMS -> 0..1 on a −60..0 dBFS scale (clamped)."""
    if rms <= 0.0 or rms != rms:
        return 0.0
    db = 20.0 * math.log10(min(1.0, rms))
    return max(0.0, min(1.0, (db + 60.0) / 60.0))


try:  # 3.12+: the sum of products runs in C, keeping per-frame RMS cheap
    _sumprod = math.sumprod
except AttributeError:  # pragma: no cover - Python < 3.12
    def _sumprod(a, b):
        return sum(x * y for x, y in zip(a, b))


def frame_rms(samples) -> float:
    """RMS of one PCM frame (float32 LE bytes, or any numeric sequence).

    Lean by design: this runs for every outgoing audio frame (~47 fps), not
    just the ~10 Hz feature windows. Values are deliberately *not* clamped —
    ``level_from_rms`` clamps at 1.0 and maps NaN to 0.0 anyway.
    """
    if isinstance(samples, (bytes, bytearray, memoryview)):
        raw = bytes(samples)
        count = len(raw) // 4
        if count == 0:
            return 0.0
        vals = struct.unpack(f"<{count}f", raw[: count * 4])
    else:
        try:
            vals = tuple(float(v) for v in samples)
        except (TypeError, ValueError):
            return 0.0
        count = len(vals)
        if count == 0:
            return 0.0
    return math.sqrt(_sumprod(vals, vals) / count)


class FrameSilence:
    """Per-PCM-frame silence flag with a short hold (anti-flicker hysteresis).

    ``Analyser`` refreshes its ``silence`` every ~100 ms and starts silent, so
    copying that flag onto every outgoing PCM frame wrongly flags the first
    frames of a song (and frames right after a quiet stretch) as silent while
    they carry real audio. Instead, each frame is judged from *its own*
    samples: silent only when its level is below ``silence_level`` *and* no
    frame within the last ``hold_ms`` was loud. One quiet frame inside music
    therefore keeps the flag held open; after ``hold_ms`` of quiet it flips.
    """

    def __init__(self, silence_level: float = SILENCE_LEVEL,
                 hold_ms: float = FRAME_SILENCE_HOLD_MS):
        self.silence_level = silence_level
        self.hold_ms = hold_ms
        self._last_loud_ms: float | None = None

    def reset(self) -> None:
        self._last_loud_ms = None

    def is_silent(self, samples, ts_ms: float) -> bool:
        ts = float(ts_ms)
        if self._last_loud_ms is not None and ts < self._last_loud_ms:
            ts = self._last_loud_ms  # keep monotonic; the hold never rewinds
        if level_from_rms(frame_rms(samples)) >= self.silence_level:
            self._last_loud_ms = ts
            return False
        if self._last_loud_ms is None:
            return True  # nothing loud yet: silence from the start
        return (ts - self._last_loud_ms) > self.hold_ms


# ---------------------------------------------------------------------------
# analyser
# ---------------------------------------------------------------------------

class Analyser:
    """Stateful, deterministic feature extractor.

    Feed successive windows with monotonically non-decreasing ``ts_ms``. The
    same input sequence always yields the same output; there is no randomness,
    no wall clock and no global state.
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE):
        self.sample_rate = sample_rate
        self.reset()

    def reset(self) -> None:
        self._agc_env = [AGC_FLOOR] * len(BAND_CENTERS)
        self._agc_gain = [1.0] * len(BAND_CENTERS)
        self._prev_mags = [0.0] * (FFT_SIZE // 2 + 1)
        self._last_onset_ms: float | None = None
        self._last_loud_ms: float | None = None
        self._last_ts_ms: float | None = None

    # -- pieces ------------------------------------------------------------
    def _bands(self, mags: list[float]) -> list[float]:
        out = []
        for i, (lo, hi) in enumerate(_BANDS):
            energy = 0.0
            for k in range(lo, hi + 1):
                energy += mags[k]
            energy /= max(1, hi - lo + 1)
            env = self._agc_env[i]
            if energy > env:
                env = 0.5 * energy + 0.5 * env  # attack: follow loud content quickly
            else:
                env = env * AGC_DECAY + energy * (1.0 - AGC_DECAY)
            env = max(env, AGC_FLOOR)
            self._agc_env[i] = env
            target_gain = 0.5 / env
            gain = self._agc_gain[i] + (target_gain - self._agc_gain[i]) * AGC_ADAPT
            gain = max(0.05, min(200.0, gain))  # ≤46 dB boost: lifts quiet passages, not leakage
            self._agc_gain[i] = gain
            out.append(max(0.0, min(1.0, energy * gain)))
        return out

    def _onset(self, mags: list[float], level: float, ts_ms: float) -> bool:
        flux = 0.0
        total = 0.0
        for k in range(1, len(mags)):
            cur = mags[k]
            prev = self._prev_mags[k]
            total += cur
            if cur > prev:
                flux += cur - prev
        self._prev_mags = list(mags)
        if total <= 1e-9:
            return False
        score = flux / total
        if level < 0.03 or score < ONSET_THRESHOLD:
            return False
        if self._last_onset_ms is not None and ts_ms - self._last_onset_ms < ONSET_REFRACTORY_MS:
            return False
        self._last_onset_ms = ts_ms
        return True

    def _centroid(self, mags: list[float]) -> float:
        total = 0.0
        weighted = 0.0
        df = self.sample_rate / float(FFT_SIZE)
        for k in range(1, len(mags)):
            m = mags[k]
            total += m
            weighted += m * k * df
        if total <= 1e-12:
            return 0.0
        nyquist = self.sample_rate / 2.0
        return max(0.0, min(1.0, (weighted / total) / nyquist))

    def _flatness(self, mags: list[float]) -> float:
        power = [m * m for m in mags[1:]]
        if not power:
            return 0.0
        arith = sum(power) / len(power)
        if arith <= 1e-12:
            return 0.0
        logs = 0.0
        floor = 1e-12
        for p in power:
            logs += math.log(max(p, floor))
        geo = math.exp(logs / len(power))
        return max(0.0, min(1.0, geo / arith))

    # -- public ------------------------------------------------------------
    def analyse(self, samples, ts_ms: float | None = None) -> dict:
        """Return the §3 feature dict for this window."""
        values = _coerce(samples)
        if ts_ms is None:
            ts_ms = (self._last_ts_ms or 0.0) + 1000.0 * FFT_SIZE / self.sample_rate
        ts_ms = float(ts_ms)
        if self._last_ts_ms is not None and ts_ms < self._last_ts_ms:
            ts_ms = self._last_ts_ms  # keep monotonic; late frames do not rewind time
        self._last_ts_ms = ts_ms

        rms = _rms(values[:FFT_SIZE])
        level = level_from_rms(rms)
        mags = magnitude_spectrum(values)
        bands = self._bands(mags)
        onset = self._onset(mags, level, ts_ms)
        centroid = self._centroid(mags)
        flatness = self._flatness(mags)

        if level >= SILENCE_LEVEL:
            self._last_loud_ms = ts_ms
        if self._last_loud_ms is None:
            self._last_loud_ms = ts_ms
        silence = level < SILENCE_LEVEL and (ts_ms - self._last_loud_ms) > SILENCE_MS

        return {
            "level": level,
            "bands": bands,
            "onset": onset,
            "centroid": centroid,
            "flatness": flatness,
            "silence": silence,
        }


def silence_features(ts_ms: float | None = None) -> dict:
    """All-zero, silent feature dict (used when no capture device exists)."""
    return {
        "level": 0.0,
        "bands": [0.0] * len(BAND_CENTERS),
        "onset": False,
        "centroid": 0.0,
        "flatness": 0.0,
        "silence": True,
    }
