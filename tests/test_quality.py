"""Quality choices — what each source actually allows, measured not assumed.

Three sources, three honest answers:

* **archive.org** publishes real derivatives per item (``*_512kb.mp4``,
  ``*.ogv``, the original), each with its own size and resolution. Those are
  real choices, so they are offered — parsed from ``/metadata/<id>``, which the
  Aura server fetches (short timeout, small cache), never the desktop.
* **YouTube** ignores ``setPlaybackQuality`` (measured: sending small/medium/
  hd720/hd1080/large left ``playbackQuality`` at hd1080 and ``preferredQuality``
  at ``auto``), so its one honest choice is "Auto (YouTube decides)".
* **a direct file** is one file: no picker.

No network: the item's metadata is a recorded fixture (a real archive.org
answer, trimmed), and the fetch is stubbed where it would be called.

Run: /usr/bin/python3 -m pytest tests/test_quality.py -q
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import urllib.parse

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import quality, server  # noqa: E402

FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures" / "archive_metadata_the_general.json"
ITEM = "The_General_Buster_Keaton"
BASE = f"https://archive.org/download/{ITEM}/"
ORIGINAL = BASE + "The_General.mp4"
SMALLEST = BASE + "The_General_512kb.mp4"
OGV = BASE + "The_General.ogv"
FILM = BASE + "The_General.mp4"


def metadata() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _no_cache():
    quality.clear_cache()
    yield
    quality.clear_cache()


# ---------------------------------------------------------------------------
# archive.org: the item's real files
# ---------------------------------------------------------------------------

def test_the_recorded_item_yields_its_real_mp4_and_ogv_choices():
    payload = quality.choices_from_metadata(metadata(), ITEM)
    assert payload["ok"] is True
    assert payload["mode"] == "archive"
    assert payload["item"] == ITEM
    names = [choice["file"] for choice in payload["choices"]]
    # The three playable files, largest first — and nothing else: no .avi
    # (Chrome cannot play Cinepack), no .gif, no jpg/thumb/xml/torrent.
    assert names == ["The_General.mp4", "The_General.ogv", "The_General_512kb.mp4"]
    assert payload["choices"][0]["url"] == ORIGINAL
    assert payload["choices"][0]["height"] == 480
    assert payload["choices"][0]["size_bytes"] == 412400222
    assert payload["choices"][0]["label"] == "640×480 · 393 MB · h.264"
    assert payload["smallest"] == SMALLEST
    assert payload["largest"] == ORIGINAL


def test_the_file_the_film_is_playing_is_marked_current():
    payload = quality.choices_from_metadata(metadata(), ITEM, current_url=SMALLEST)
    current = [choice for choice in payload["choices"] if choice["current"]]
    assert len(current) == 1, "exactly one choice is the one on screen"
    assert current[0]["url"] == SMALLEST
    assert payload["current"] == SMALLEST


def test_a_file_with_no_resolution_in_the_metadata_still_gets_a_label():
    payload = {"files": [{"name": "film.mp4", "size": "1048576", "source": "original"}]}
    choices = quality.choices_from_metadata(payload, "item")["choices"]
    assert len(choices) == 1
    assert choices[0]["height"] is None
    assert choices[0]["label"] == "1 MB · MP4"
    assert choices[0]["source"] == "original"


def test_archive_download_urls_are_recognised_and_others_are_not():
    assert quality.archive_download(ORIGINAL) == (ITEM, "The_General.mp4")
    assert quality.archive_download(f"https://archive.org/details/{ITEM}") == (ITEM, "")
    assert quality.archive_download("https://web.archive.org/web/2020/" + ORIGINAL) is None
    assert quality.archive_download("https://archive.org.example.com/download/x/y.mp4") is None
    assert quality.archive_download("https://www.youtube.com/watch?v=EF8C4v7JIbA") is None
    assert quality.archive_download("http://example.org/film.mp4") is None
    assert quality.archive_download("") is None
    assert quality.archive_download("javascript:alert(1)") is None


def test_the_metadata_fetch_is_cached_and_its_timeout_is_short(monkeypatch):
    calls = []

    def fake(item_id):
        calls.append(item_id)
        return metadata()

    monkeypatch.setattr(quality, "_fetch_metadata", fake)
    first = quality.choices_for(ORIGINAL)
    second = quality.choices_for(SMALLEST)
    assert first["ok"] is True and second["ok"] is True
    assert calls == [ITEM], "the second lookup refetched the same item"
    quality.clear_cache()
    quality.choices_for(ORIGINAL)
    assert calls == [ITEM, ITEM], "clear_cache did not drop the item"
    assert quality.METADATA_TIMEOUT <= 6.0, "a quality lookup must not stall the player"


def test_metadata_that_cannot_be_read_is_reported_not_invented(monkeypatch):
    monkeypatch.setattr(quality, "_fetch_metadata", lambda item_id: None)
    payload = quality.choices_for(ORIGINAL)
    assert payload["ok"] is False
    assert payload["error"] == "metadata_unavailable"
    assert payload["choices"] == []
    assert "archive.org" in payload["hint"]


def test_a_broken_metadata_answer_makes_no_choices(monkeypatch):
    monkeypatch.setattr(quality, "_fetch_metadata", lambda item_id: {"files": "not a list"})
    payload = quality.choices_for(ORIGINAL)
    assert payload["ok"] is False
    assert payload["choices"] == []


# ---------------------------------------------------------------------------
# YouTube and direct files: the honest single answer
# ---------------------------------------------------------------------------

def test_youtube_offers_only_auto_because_the_api_is_ignored():
    payload = quality.choices_for("https://www.youtube.com/watch?v=EF8C4v7JIbA")
    assert payload["ok"] is True
    assert payload["mode"] == "youtube"
    assert len(payload["choices"]) == 1
    choice = payload["choices"][0]
    assert choice["label"] == "Auto (YouTube decides)"
    assert choice["url"] == ""
    assert payload["smallest"] == "" and payload["largest"] == ""
    assert "deprecated" in payload["note"]


def test_a_direct_file_has_one_choice_and_no_picker():
    payload = quality.choices_for("https://example.org/films/octopus.mp4")
    assert payload["ok"] is True
    assert payload["mode"] == "single"
    assert len(payload["choices"]) == 1
    assert payload["choices"][0]["url"] == "https://example.org/films/octopus.mp4"
    assert payload["choices"][0]["current"] is True


def test_a_non_film_url_is_refused():
    for url in ("", "   ", "javascript:alert(1)", "file:///etc/passwd"):
        payload = quality.choices_for(url)
        assert payload["ok"] is False, url
        assert payload["error"] == "not_a_film"


# ---------------------------------------------------------------------------
# the server endpoint
# ---------------------------------------------------------------------------

@pytest.fixture()
def live(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    monkeypatch.setattr(quality, "_fetch_metadata", lambda item_id: metadata())
    server.stop_server()
    server.ensure_server()
    port, token = server.get_port(), server.get_token()
    assert port and token, "server did not start"
    try:
        yield {"port": port, "token": token}
    finally:
        server.stop_server()


def _get(port, token, path):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    conn.request("GET", path, headers=headers)
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, json.loads(body or b"{}")


def test_the_endpoint_serves_the_parsed_choices(live):
    import urllib.parse

    path = "/api/quality?url=" + urllib.parse.quote(ORIGINAL, safe="")
    status, payload = _get(live["port"], live["token"], path)
    assert status == 200
    assert payload["ok"] is True
    assert payload["mode"] == "archive"
    assert [c["file"] for c in payload["choices"]] == [
        "The_General.mp4", "The_General.ogv", "The_General_512kb.mp4"]
    assert payload["smallest"] == SMALLEST


def test_the_endpoint_needs_the_token(live):
    status, payload = _get(live["port"], "", "/api/quality?url=" + ORIGINAL)
    assert status == 401
    assert payload["ok"] is False


def test_the_endpoint_answers_a_youtube_url_with_auto(live):
    import urllib.parse

    path = "/api/quality?url=" + urllib.parse.quote(
        "https://www.youtube.com/watch?v=EF8C4v7JIbA", safe="")
    status, payload = _get(live["port"], live["token"], path)
    assert status == 200
    assert payload["mode"] == "youtube"
    assert payload["choices"][0]["label"] == "Auto (YouTube decides)"


# ---------------------------------------------------------------------------
# the queued command
# ---------------------------------------------------------------------------

def test_a_quality_command_carries_a_url_and_no_giant_payload():
    server.pending_commands(0)
    result = server.enqueue_command({"cmd": "quality", "url": SMALLEST})
    assert result["ok"] is True
    assert result["command"]["url"] == SMALLEST


def test_a_quality_command_carries_a_preference():
    result = server.enqueue_command({"cmd": "quality", "preference": "smallest"})
    assert result["ok"] is True
    assert result["command"]["preference"] == "smallest"


def test_a_quality_command_with_nothing_to_do_is_refused():
    with pytest.raises(ValueError):
        server.enqueue_command({"cmd": "quality"})
    with pytest.raises(ValueError):
        server.enqueue_command({"cmd": "quality", "preference": "biggest"})


# ---------------------------------------------------------------------------
# the dashboard mirror (the desktop's only door to the server)
# ---------------------------------------------------------------------------

@pytest.fixture()
def dashboard(monkeypatch):
    """Import dashboard/plugin_api.py with a tiny fastapi stand-in."""
    import types

    routes = []

    class Router:
        def _record(self, method):
            def decorator(path):
                def register(fn):
                    routes.append((method, path, fn))
                    return fn
                return register
            return decorator

        def get(self, path):
            return self._record("GET")(path)

        def post(self, path):
            return self._record("POST")(path)

        def delete(self, path):
            return self._record("DELETE")(path)

    fake = types.ModuleType("fastapi")
    fake.APIRouter = Router
    fake.Request = object

    def JSONResponse(payload, status_code=200):
        return (status_code, payload)

    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = JSONResponse
    fake.responses = responses
    fake.JSONResponse = JSONResponse
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    monkeypatch.setitem(sys.modules, "fastapi.responses", responses)
    monkeypatch.delitem(sys.modules, "dashboard.plugin_api", raising=False)
    import importlib

    module = importlib.import_module("dashboard.plugin_api")
    module.__dict__["_QUALITY_ROUTES"] = routes
    return module


def test_dashboard_forwards_the_quality_lookup(dashboard, monkeypatch):
    seen = []

    def forward(path, body=None, timeout=5.0):
        seen.append(path)
        return 200, {"ok": True, "mode": "archive", "choices": []}

    monkeypatch.setattr(dashboard, "_forward_json", forward)
    payload = dashboard.quality(url=ORIGINAL)
    assert seen == ["/api/quality?url=" + urllib.parse.quote(ORIGINAL, safe="")]
    assert payload["mode"] == "archive"
    assert ("GET", "/quality") in {(method, path) for method, path, _ in dashboard._QUALITY_ROUTES}
