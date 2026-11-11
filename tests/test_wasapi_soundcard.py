"""Windows capture: soundcard loopback is preferred; off Windows the backend says no and never raises."""

import sys

import pytest

from aura_core.capture import wasapi


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
