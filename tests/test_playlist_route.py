"""Playlist resolution tests — the dashboard route that lists a playlist's episodes.

The page carries ``ytInitialData`` in one script and other assignments in later
ones; a pattern that runs past the closing ``;</script>`` swallows the next
script and the whole list is lost. No network: ``urlopen`` is replaced.

Run: .venv/bin/python -m pytest tests/test_playlist_route.py -q
"""

from __future__ import annotations

import importlib
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

LIST_ID = "PL0123456789"
EPISODE_ID = "dQw4w9WgXcQ"

# One episode in ytInitialData, then an unrelated assignment in the next script.
PAGE_TWO_SCRIPTS = (
    "<html><head>"
    '<script nonce="abc">var ytInitialData = {"contents":{"twoColumnWatchNextResults":'
    '{"playlist":{"playlist":{"contents":[{"playlistVideoRenderer":{"videoId":"'
    + EPISODE_ID
    + '","title":{"runs":[{"text":"Episode one"}]},"lengthText":{"simpleText":"12:34"}}}]}}}}};'
    "</script>"
    "<script>var settings={};</script>"
    "</head><body></body></html>"
)

PAGE_ONE_SCRIPT = (
    "<html><head>"
    '<script nonce="abc">var ytInitialData = {"contents":{"twoColumnWatchNextResults":'
    '{"playlist":{"playlist":{"contents":[{"playlistVideoRenderer":{"videoId":"'
    + EPISODE_ID
    + '","title":{"runs":[{"text":"Episode one"}]},"lengthText":{"simpleText":"12:34"}}}]}}}}};'
    "</script>"
    "</head><body></body></html>"
)


@pytest.fixture()
def dashboard():
    """Import dashboard/plugin_api.py with a tiny fastapi stand-in."""
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
    responses = types.ModuleType("fastapi.responses")
    responses.JSONResponse = lambda payload, status_code=200: (status_code, payload)
    fake.responses = responses
    sys.modules["fastapi"] = fake
    sys.modules["fastapi.responses"] = responses
    try:
        sys.modules.pop("dashboard.plugin_api", None)
        module = importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)
    module.__dict__["_PLAYLIST_ROUTES"] = routes
    return module


@pytest.fixture(autouse=True)
def _fresh_cache(dashboard):
    dashboard._PLAYLIST_CACHE.clear()
    yield
    dashboard._PLAYLIST_CACHE.clear()


def _serve(monkeypatch, html):
    """Answer every urlopen with ``html``, the way the real page route does."""
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return html.encode("utf-8")

    monkeypatch.setattr(
        "urllib.request.urlopen", lambda request, timeout=None: Response())


def test_dashboard_registers_get_playlist(dashboard):
    seen = {(method, path) for method, path, _ in dashboard._PLAYLIST_ROUTES}
    assert ("GET", "/playlist") in seen


def test_playlist_route_returns_the_episode(dashboard, monkeypatch):
    _serve(monkeypatch, PAGE_ONE_SCRIPT)
    payload = dashboard.playlist(LIST_ID)
    assert payload["ok"] is True
    assert [item["videoId"] for item in payload["items"]] == [EPISODE_ID]


def test_playlist_route_survives_a_second_script(dashboard, monkeypatch):
    # A later `<script>var settings={};</script>` used to be swallowed by a greedy
    # match, so json.loads() rejected the page and the desktop got no episode list.
    _serve(monkeypatch, PAGE_TWO_SCRIPTS)
    payload = dashboard.playlist(LIST_ID)
    assert payload["ok"] is True, payload
    assert [item["videoId"] for item in payload["items"]] == [EPISODE_ID]


def test_playlist_route_page_without_initial_data_is_an_empty_list(dashboard, monkeypatch):
    _serve(monkeypatch, "<html><body>consent</body></html>")
    assert dashboard.playlist(LIST_ID)["items"] == []
