"""Radio adaptation tests (aura_core/radio.py) + the dashboard radio routes.

The network is faked, never touched: ``_rb_open`` and ``_open`` are replaced
with in-memory responses, so these tests are deterministic and offline.

Run: .venv/bin/python -m pytest tests/test_radio.py -q
"""

from __future__ import annotations

import json
import os
import sys
import types

import pytest

from aura_core import config, radio


# ---------------------------------------------------------------------------
# offline fixtures
# ---------------------------------------------------------------------------

class FakeResponse:
    """Just enough of an http.client response for the code under test."""

    def __init__(self, body=b"", headers=None, url=""):
        self._body = body
        self.headers = headers or {}
        self._url = url

    def read(self, *args):
        return self._body

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """One mirror, no cooldown, empty caches — every test starts clean."""
    monkeypatch.setattr(radio, "RADIO_BROWSER_SERVERS", ["https://de1.api.radio-browser.info"])
    radio.reset_caches()
    yield
    radio.reset_caches()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def station(uuid, name, url, **extra):
    row = {"stationuuid": uuid, "name": name, "url_resolved": url, "tags": "jazz, chill",
           "codec": "MP3", "bitrate": 128, "country": "Germany", "countrycode": "DE",
           "votes": 10, "clickcount": 100, "homepage": "https://example.fm"}
    row.update(extra)
    return row


def serve(monkeypatch, rows, total=None):
    """Fake Radio Browser: every request answers with *rows*."""
    calls = []

    def fake_open(req, timeout):
        calls.append((req.full_url, timeout))
        headers = {} if total is None else {"x-rbtotal": str(total)}
        return FakeResponse(json.dumps(rows).encode("utf-8"), headers)

    monkeypatch.setattr(radio, "_rb_open", fake_open)
    return calls


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------

def test_search_normalizes_stations(monkeypatch):
    serve(monkeypatch, [station("abc", " Jazz FM ", "https://ice.example/jazz.mp3")])
    rows = radio.search("jazz", limit=5)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "rb-abc"
    assert row["name"] == "Jazz FM"
    assert row["url"] == "https://ice.example/jazz.mp3"
    assert row["tags"] == ["jazz", "chill"]
    assert row["countrycode"] == "DE"
    assert row["source"] == "radiobrowser"


def test_search_drops_hls_and_empty_urls(monkeypatch):
    serve(monkeypatch, [
        station("a", "HLS", "https://ice.example/live.m3u8"),
        station("b", "Flagged", "https://ice.example/stream", hls=1),
        {"stationuuid": "c", "name": "No URL"},
        station("d", "Good", "https://ice.example/good.mp3"),
    ])
    rows = radio.search("anything", limit=10)
    assert [r["name"] for r in rows] == ["Good"]


def test_search_is_cached_per_query(monkeypatch):
    calls = serve(monkeypatch, [station("abc", "Jazz FM", "https://ice.example/jazz.mp3")])
    radio.search("jazz")
    radio.search("jazz")
    assert len(calls) == 1, "a cached query must not hit the network again"
    radio.search("other")
    assert len(calls) == 2, "a different query is a different cache key"


def test_search_falls_back_when_every_mirror_fails(monkeypatch):
    def boom(req, timeout):
        raise OSError("network is down")

    monkeypatch.setattr(radio, "_rb_open", boom)
    with pytest.raises(radio.RadioUnavailable):
        radio.search("jazz")


# ---------------------------------------------------------------------------
# popular
# ---------------------------------------------------------------------------

def test_popular_puts_presets_first_and_filters_junk(monkeypatch):
    serve(monkeypatch, [
        station("spam", "TEST TEST RADIO | ★★♦♦", "https://x/spam.mp3"),
        station("stuffed", "Vote Farm", "https://x/stuffed.mp3", votes=9000, clickcount=10),
        station("low", "Tiny Bitrate", "https://x/low.mp3", bitrate=16),
        station("a", "Radio Eins", "https://x/eins.mp3"),
        station("b", "Radio Zwei", "https://x/zwei.mp3"),
        # A clone of a preset name must not appear twice.
        station("c", "SomaFM Groove Salad (128k MP3)", "https://x/clone.mp3"),
        station("d", "Radio Drei", "https://x/drei.mp3"),
    ])
    rows = radio.popular(limit=6)
    names = [r["name"] for r in rows]
    assert names[:6] == names[:6]
    assert rows[0]["source"] == "preset", "presets lead the popular list"
    assert "Vote Farm" not in names
    assert "Tiny Bitrate" not in names
    assert not any("TEST TEST" in name for name in names)
    assert sum(1 for n in names if n.startswith("SomaFM Groove Salad")) == 1


def test_popular_survives_an_outage(monkeypatch):
    def boom(req, timeout):
        raise OSError("down")

    monkeypatch.setattr(radio, "_rb_open", boom)
    rows = radio.popular(limit=4)
    assert len(rows) == 4
    assert all(r["source"] == "preset" for r in rows)


# ---------------------------------------------------------------------------
# favorites
# ---------------------------------------------------------------------------

def test_favorites_roundtrip_and_dedupe_by_url(home):
    assert radio.favorites() == []
    radio.add_favorite({"name": "Jazz FM", "url": "https://ice.example/jazz.mp3"})
    added = radio.add_favorite({"name": "Jazz FM better", "url": "https://ice.example/jazz.mp3/"})
    favs = radio.favorites()
    assert len(favs) == 1, "the same stream URL must not be stored twice"
    assert favs[0]["name"] == "Jazz FM better"
    assert favs[0]["id"] == added["id"]
    assert (home / "aura" / "radio_favorites.json").exists()
    if os.name != "nt":  # NTFS has no POSIX mode bits; the profile ACL protects the file
        assert oct(os.stat(home / "aura" / "radio_favorites.json").st_mode)[-3:] == "600"
    assert radio.remove_favorite(added["id"]) is True
    assert radio.favorites() == []
    assert radio.remove_favorite(added["id"]) is False


def test_favorite_needs_a_url(home):
    with pytest.raises(radio.RadioError):
        radio.add_favorite({"name": "nothing"})


# ---------------------------------------------------------------------------
# stream safety (the SSRF guard)
# ---------------------------------------------------------------------------

def test_stream_url_rejects_non_public_schemes_and_creds(monkeypatch):
    for bad in ("file:///etc/passwd", "ftp://example.com/x.mp3", "javascript:alert(1)",
                "https://user:pass@example.com/x.mp3", "", None):
        assert radio.safe_stream_url(bad) is False, bad


def _answers(*addresses):
    return [(2, 1, 6, "", (address, 80)) for address in addresses]


def test_stream_url_rejects_private_and_loopback(monkeypatch):
    for address in ("127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "::1", "fe80::1"):
        monkeypatch.setattr(radio.socket, "getaddrinfo", lambda *a, _addr=address, **k: _answers(_addr))
        assert radio.safe_stream_url("https://innocent.example/stream.mp3") is False, address


def test_stream_url_allows_a_public_host(monkeypatch):
    monkeypatch.setattr(radio.socket, "getaddrinfo", lambda *a, **k: _answers("93.184.216.34"))
    assert radio.safe_stream_url("https://innocent.example/stream.mp3") is True
    # One private answer among public ones is still a refusal.
    monkeypatch.setattr(radio.socket, "getaddrinfo",
                        lambda *a, **k: _answers("93.184.216.34", "127.0.0.1"))
    assert radio.safe_stream_url("https://innocent.example/stream.mp3") is False


def test_prepare_stream_rejects_a_private_url_outright():
    with pytest.raises(radio.RadioError):
        radio.prepare_stream("http://127.0.0.1:8000/radio.mp3")
    with pytest.raises(radio.RadioError):
        radio.prepare_stream("")


def test_resolve_playlist_reads_pls_and_m3u(monkeypatch):
    monkeypatch.setattr(radio, "safe_stream_url", lambda url: True)

    def fake_open(url, headers, timeout):
        if url.endswith(".pls"):
            return FakeResponse(b"[playlist]\nFile1=https://ice.example/real.mp3\n", url=url)
        return FakeResponse(b"#EXTM3U\n#EXTINF:-1,Station\nhttps://ice.example/m3u.mp3\n", url=url)

    monkeypatch.setattr(radio, "_open", fake_open)
    assert radio.resolve_playlist_url("https://ice.example/list.pls") == "https://ice.example/real.mp3"
    assert radio.resolve_playlist_url("https://ice.example/list.m3u") == "https://ice.example/m3u.mp3"
    # A direct stream is returned unchanged, without any network call.
    assert radio.resolve_playlist_url("https://ice.example/direct.mp3") == "https://ice.example/direct.mp3"


def test_resolve_playlist_refuses_a_private_entry(monkeypatch):
    # The playlist body is upstream data: an entry pointing at the LAN must be
    # refused and the original URL kept.
    monkeypatch.setattr(radio, "safe_stream_url", lambda url: "127.0.0.1" not in str(url))
    monkeypatch.setattr(radio, "_open", lambda url, headers, timeout:
                        FakeResponse(b"File1=http://127.0.0.1/secret.mp3", url=url))
    assert radio.resolve_playlist_url("https://ice.example/list.pls") == "https://ice.example/list.pls"


def test_open_stream_prepares_then_opens_through_the_checked_opener(monkeypatch):
    # [finding 9] The proxy streams through the same validated/pinned opener;
    # it must never call the browser's raw hostname directly.
    calls = {}
    sentinel = FakeResponse(b"", url="https://ice.example/prepared.mp3")

    monkeypatch.setattr(radio, "prepare_stream",
                        lambda url: calls.setdefault("prepared", "https://ice.example/prepared.mp3"))
    monkeypatch.setattr(radio, "_open", lambda url, headers, timeout:
                        calls.update(url=url, headers=headers, timeout=timeout) or sentinel)

    assert radio.open_stream("https://ice.example/list.pls") is sentinel
    assert calls["url"] == "https://ice.example/prepared.mp3"
    assert calls["headers"]["User-Agent"] == radio.UA
    assert calls["headers"]["Icy-MetaData"] == "0"


# ---------------------------------------------------------------------------
# dashboard routes (payload builders; fastapi is stubbed, nothing is served)
# ---------------------------------------------------------------------------

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

    def JSONResponse(payload, status_code=200):
        return (status_code, payload)

    responses.JSONResponse = JSONResponse
    fake.responses = responses
    fake.JSONResponse = JSONResponse
    sys.modules["fastapi"] = fake
    sys.modules["fastapi.responses"] = responses
    try:
        sys.modules.pop("dashboard.plugin_api", None)
        import importlib
        module = importlib.import_module("dashboard.plugin_api")
    finally:
        sys.modules.pop("fastapi", None)
        sys.modules.pop("fastapi.responses", None)
    module.__dict__["_LISTEN_ROUTES"] = routes
    return module


def test_dashboard_registers_the_required_radio_routes(dashboard):
    seen = {(method, path) for method, path, _ in dashboard._LISTEN_ROUTES}
    for entry in [("GET", "/radio/search"), ("GET", "/radio/popular"), ("GET", "/radio/presets"),
                  ("GET", "/radio/favorites"), ("POST", "/radio/favorites"),
                  ("DELETE", "/radio/favorites"), ("GET", "/radio/resolve")]:
        assert entry in seen, entry


def test_dashboard_search_uses_radiobrowser(dashboard, monkeypatch):
    monkeypatch.setattr(radio, "search", lambda q, tag, limit: [station("a", "Q", "https://x/q.mp3")])
    payload = dashboard.radio_search_payload("q", "", 5)
    assert payload["ok"] is True
    assert payload["source"] == "radiobrowser"
    assert payload["stations"][0]["name"] == "Q"


def test_dashboard_search_falls_back_to_presets(dashboard, monkeypatch):
    def offline(*a, **k):
        raise radio.RadioUnavailable("down")

    monkeypatch.setattr(radio, "search", offline)
    payload = dashboard.radio_search_payload("jazz", "", 5)
    assert payload["ok"] is False
    assert payload["error"] == "radio_unreachable"
    assert payload["fallback"] is True
    assert payload["stations"], "an outage still answers with the curated presets"


def test_dashboard_favorites_add_and_remove(dashboard, home):
    code, payload = dashboard.radio_favorite_add({"name": "Jazz", "url": "https://ice.example/j.mp3"})
    assert code == 200 and payload["ok"] is True
    sid = payload["station"]["id"]
    assert dashboard.radio_favorites_payload()["stations"][0]["name"] == "Jazz"
    code, payload = dashboard.radio_favorite_remove(sid)
    assert code == 200 and payload["ok"] is True
    code, _ = dashboard.radio_favorite_remove(sid)
    assert code == 404
    code, _ = dashboard.radio_favorite_add("not an object")
    assert code == 400


def test_dashboard_resolve_validates(dashboard):
    assert dashboard.radio_resolve_payload("http://127.0.0.1/x.mp3")["ok"] is False
    assert dashboard.radio_resolve_payload("")["ok"] is False


def test_dashboard_player_routes_forward_reports_and_commands(dashboard, monkeypatch):
    import asyncio
    calls = []
    def forward(path, body=None, timeout=5):
        calls.append((path, body))
        return 200, {'ok': True, 'head_seq': 3, 'commands': []}
    monkeypatch.setattr(dashboard, '_forward_json', forward)
    class Request:
        async def json(self):
            return {'url': 'https://example.test/a.mp4', 'videoId': 'abcdefghijk'}
    assert asyncio.run(dashboard.player_report(Request()))[0] == 200
    dashboard.player_status()
    dashboard.player_commands(3)
    assert calls == [('/api/player/report', {'url': 'https://example.test/a.mp4', 'videoId': 'abcdefghijk'}),
                     ('/api/player', None), ('/api/player/commands?after=3', None)]
