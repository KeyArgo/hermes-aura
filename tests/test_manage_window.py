"""``POST /api/window/manage`` — hand a real web page to the pop-out window.

The route exists so a playlist can be curated with YouTube's own UI in Aura's
own browser profile. It must never forward anything that is not http(s), and it
must report the window's real status rather than assume one opened.
"""

from __future__ import annotations

import pytest

from aura_core import server
from aura_core import window as desktop_window


def test_manage_window_refuses_a_non_http_url(monkeypatch):
    opened = []
    monkeypatch.setattr(desktop_window, "open_page", lambda url, title="": opened.append(url))
    for bad in ["javascript:alert(1)", "file:///etc/passwd", "", None]:
        with pytest.raises(ValueError):
            server.manage_window({"url": bad})
    assert opened == []


def test_manage_window_forwards_and_reports_the_window(monkeypatch):
    opened = []

    def fake_open(url, title=""):
        opened.append(url)
        return {"open": True, "already": False, "url": url}

    monkeypatch.setattr(desktop_window, "open_page", fake_open)
    monkeypatch.setattr(desktop_window, "status", lambda: {"open": True, "pid": 99})
    out = server.manage_window({"url": "https://www.youtube.com/playlist?list=PL0123456789"})
    assert opened == ["https://www.youtube.com/playlist?list=PL0123456789"]
    assert out["ok"] is True
    assert out["window"] == {"open": True, "pid": 99}


def test_manage_window_without_a_body_is_a_client_error():
    with pytest.raises(ValueError):
        server.manage_window({})
