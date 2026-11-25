"""Windows capture: soundcard loopback is preferred; off Windows the backend says no and never raises.

The loopback also has to follow the default output: a device that keeps delivering frames never
trips the server's no-data retry, so the recorder itself has to notice the switch.
"""

import array
import sys
import time

import pytest

from aura_core.capture import wasapi

OLD_DEFAULT = "Speakers (Realtek)"
NEW_DEFAULT = "Headphones (USB)"
OLD_SAMPLE = 0.5
NEW_SAMPLE = -0.25


def test_probe_off_windows_is_unavailable_and_does_not_raise():
    if sys.platform == "win32":
        pytest.skip("Windows has a real backend")
    ok, reason = wasapi.WasapiCapture.probe()
    assert ok is False and "not Windows" in reason


def test_soundcard_is_not_imported_off_windows():
    if sys.platform == "win32":
        pytest.skip("Windows imports it for real")
    assert wasapi.import_soundcard() is None


def test_stock_sounddevice_without_loopback_is_reported_not_crashed(monkeypatch):
    class StockSD:
        class WasapiSettings:
            def __init__(self, **kwargs):
                if "loopback" in kwargs:
                    raise TypeError("unexpected keyword argument 'loopback'")

    monkeypatch.setattr(wasapi.sys, "platform", "win32")
    monkeypatch.setattr(wasapi, "import_soundcard", lambda: None)
    monkeypatch.setattr(wasapi, "import_sounddevice", lambda: StockSD)
    ok, reason = wasapi.WasapiCapture.probe()
    assert ok is False and "no WASAPI loopback" in reason
    with pytest.raises(wasapi.base.CaptureError):
        wasapi.WasapiCapture.open()


def test_plugin_declares_soundcard_for_windows_only():
    text = open("plugin.yaml", encoding="utf-8").read()
    assert 'soundcard' in text and 'sys_platform == "win32"' in text


# ---------------------------------------------------------------------------
# a default-output change moves the recorder
# ---------------------------------------------------------------------------

class _MonoFrames:
    """What ``data.mean(axis=1)`` returns for soundcard's (frames, channels) block."""

    def __init__(self, frames: int, value: float):
        self._frames = frames
        self._value = value

    def astype(self, dtype):  # noqa: ANN001 - mirrors numpy
        return self

    def tobytes(self) -> bytes:
        return array.array("f", [self._value] * self._frames).tobytes()


class _BlockedFrames:
    """soundcard's 2-D block, without pulling numpy into the test environment."""

    ndim = 2

    def __init__(self, frames: int, value: float):
        self._frames = frames
        self._value = value

    def mean(self, axis: int = 1):
        return _MonoFrames(self._frames, self._value)


class _FakeSpeaker:
    def __init__(self, name: str):
        self.name = name


class _FakeRecorder:
    def __init__(self, sample: float, numframes: int, period: float):
        self._sample = sample
        self._numframes = numframes
        self._period = period

    def __enter__(self):
        return self

    def __exit__(self, *exc):  # noqa: ANN002
        return False

    def record(self, numframes: int = 0):
        time.sleep(self._period)
        return _BlockedFrames(numframes or self._numframes, self._sample)


class _FakeLoopback:
    def __init__(self, sample: float, period: float):
        self._sample = sample
        self._period = period

    def recorder(self, samplerate: int, channels: int, blocksize: int):
        return _FakeRecorder(self._sample, blocksize, self._period)


class _FakeSoundcard:
    """Two endpoints with distinguishable PCM; ``current`` is the default output."""

    def __init__(self):
        self.current = _FakeSpeaker(OLD_DEFAULT)
        self.opened: list[str] = []

    def default_speaker(self):
        return self.current

    def get_microphone(self, id, include_loopback=False):  # noqa: A002 - soundcard's keyword
        samples = {OLD_DEFAULT: OLD_SAMPLE, NEW_DEFAULT: NEW_SAMPLE}
        self.opened.append(id)
        period = wasapi.base.FRAME_SAMPLES / wasapi.base.SAMPLE_RATE
        return _FakeLoopback(samples[id], period)


def _first_sample(cap, timeout: float = 2.0) -> float | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = cap.read(wasapi.base.FRAME_SAMPLES)
        if frame is not None:
            return array.array("f", frame)[0]
    return None


def test_loopback_follows_a_default_output_change_while_the_old_device_plays(monkeypatch):
    """A default change must move the recorder even while the old device still plays.

    A speaker that keeps producing frames holds ``last_data`` fresh, so the
    server's no-data retry never fires and capture has to re-resolve the
    default output itself.
    """
    fake = _FakeSoundcard()
    monkeypatch.setattr(wasapi.sys, "platform", "win32")
    monkeypatch.setattr(wasapi, "import_soundcard", lambda: fake)

    cap = wasapi.WasapiCapture.open()
    try:
        assert cap.name == "wasapi"
        assert _first_sample(cap) == OLD_SAMPLE, "capture did not open on the default output"

        # The user plugs in headphones and makes them the default while the old
        # speakers keep playing: no gap, no re-probe, so nothing else notices.
        fake.current = _FakeSpeaker(NEW_DEFAULT)

        deadline = time.monotonic() + 4.0
        seen = None
        while time.monotonic() < deadline:
            sample = _first_sample(cap, timeout=0.5)
            if sample is not None:
                seen = sample
                if seen == NEW_SAMPLE:
                    break
        assert seen == NEW_SAMPLE, (
            f"capture stayed on {OLD_DEFAULT} after the default output changed to {NEW_DEFAULT} "
            f"(last sample {seen!r})")
        assert fake.opened == [OLD_DEFAULT, NEW_DEFAULT], fake.opened
    finally:
        cap.close()

