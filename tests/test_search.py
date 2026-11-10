"""YouTube search tests — the three result shapes, the cache, and honest
degradation. No network: ``_fetch`` is replaced with a saved page.

Run: .venv/bin/python -m pytest tests/test_search.py -q
"""

from __future__ import annotations

import pathlib
import sys
import urllib.error

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import search  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "youtube_results.html"


@pytest.fixture(autouse=True)
def clean_cache():
    search.clear_cache()
    yield
    search.clear_cache()


@pytest.fixture()
def page(monkeypatch):
    html = FIXTURE.read_text(encoding="utf-8")
    calls = []

    def fake_fetch(query):
        calls.append(query)
        return html

    monkeypatch.setattr(search, "_fetch", fake_fetch)
    return calls


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

def test_fixture_yields_one_row_per_usable_result(page):
    items = search.youtube_search("octopus documentary", 6)
    assert [item["kind"] for item in items] == ["video", "playlist", "video", "playlist"]
    assert [item["id"] for item in items] == [
        "3GB-7qwwIp0",
        "PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6",
        "ah8U0-fV6k8",
        "PLQgyOUGZUlLu4LEriF6UtF5Vu-RSYCbgz",
    ]
    assert page == ["octopus documentary"]


def test_video_renderer_fields(page):
    first = search.youtube_search("octopus documentary", 1)[0]
    assert first["url"] == "https://www.youtube.com/watch?v=3GB-7qwwIp0"
    assert first["channel"] == "Nat Geo Animals"
    assert first["length"] == "2:03:39"
    assert first["views"] == "2,946,453 views"


def test_title_with_braces_is_not_truncated(page):
    # The page declares ytInitialData with a greedy regex would cut at the first
    # '}' inside a title; decoding from the first '{' must keep the whole title.
    first = search.youtube_search("octopus documentary", 1)[0]
    assert first["title"] == "Secrets of the Octopus {the real one} | MEGA EPISODE"


def test_playlist_renderer_fields(page):
    playlist = search.youtube_search("octopus documentary", 6)[1]
    assert playlist["url"] == (
        "https://www.youtube.com/playlist?list=PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6")
    assert playlist["channel"] == "Timely Documentaries"
    assert playlist["length"] == "8 videos"
    assert playlist["views"] == "54,332 views"


def test_lockup_video_and_playlist_shapes(page):
    items = search.youtube_search("octopus documentary", 6)
    video = items[2]
    assert video["kind"] == "video"
    assert video["title"] == "Masterminds: Secrets of the Octopus (Full Episode)"
    assert video["channel"] == "National Geographic"
    assert video["length"] == "42:32"
    assert video["views"] == "2.1M views"
    playlist = items[3]
    assert playlist["kind"] == "playlist"
    assert playlist["channel"] == "Kevin Smuts"
    assert playlist["length"] == "33 videos"
    assert playlist["url"] == (
        "https://www.youtube.com/playlist?list=PLQgyOUGZUlLu4LEriF6UtF5Vu-RSYCbgz")


def test_duplicates_and_invalid_ids_are_dropped(page):
    items = search.youtube_search("octopus documentary", 12)
    ids = [(item["kind"], item["id"]) for item in items]
    assert len(ids) == len(set(ids))
    assert all(item["id"] != "too-short" for item in items)
    assert len(items) == 4  # 5 video rows in the page, 2 unusable


def test_limit_slices_the_result(page):
    assert len(search.youtube_search("octopus documentary", 2)) == 2
    assert len(search.youtube_search("octopus documentary", 1)) == 1


def test_limit_is_clamped(page, monkeypatch):
    monkeypatch.setattr(search, "MAX_LIMIT", 3)
    assert len(search.youtube_search("octopus documentary", 999)) == 3
    assert len(search.youtube_search("octopus documentary", 0)) == 1


# ---------------------------------------------------------------------------
# cache
# ---------------------------------------------------------------------------

def test_second_search_is_served_from_the_cache(page):
    search.youtube_search("octopus documentary", 6)
    search.youtube_search("octopus documentary", 6)
    assert page == ["octopus documentary"]


def test_case_and_spacing_share_one_cache_entry(page):
    search.youtube_search("Octopus Documentary", 6)
    search.youtube_search("  octopus documentary ", 6)
    assert page == ["Octopus Documentary"]


def test_a_wider_limit_reuses_the_cached_rows(page):
    assert len(search.youtube_search("octopus documentary", 2)) == 2
    assert len(search.youtube_search("octopus documentary", 4)) == 4
    assert page == ["octopus documentary"]


def test_expired_cache_refetches(page, monkeypatch):
    clock = {"now": 1_000_000.0}
    monkeypatch.setattr(search.time, "time", lambda: clock["now"])
    search.youtube_search("octopus documentary", 6)
    clock["now"] += search.CACHE_TTL + 1
    search.youtube_search("octopus documentary", 6)
    assert page == ["octopus documentary", "octopus documentary"]


def test_cached_rows_are_copies(page):
    first = search.youtube_search("octopus documentary", 6)
    first[0]["title"] = "mutated by a caller"
    assert search.youtube_search("octopus documentary", 6)[0]["title"] != "mutated by a caller"


# ---------------------------------------------------------------------------
# degradation — always a list, never an exception
# ---------------------------------------------------------------------------

def test_network_outage_returns_an_empty_list(monkeypatch):
    def offline(query):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(search, "_fetch", offline)
    assert search.youtube_search("octopus documentary") == []


def test_page_without_initial_data_returns_an_empty_list(monkeypatch):
    monkeypatch.setattr(search, "_fetch", lambda query: "<html><body>consent</body></html>")
    assert search.youtube_search("octopus documentary") == []


def test_truncated_json_returns_an_empty_list(monkeypatch):
    monkeypatch.setattr(
        search, "_fetch",
        lambda query: "<script>var ytInitialData = {\"contents\":{\"a\":1</script>")
    assert search.youtube_search("octopus documentary") == []


def test_fetch_returning_junk_returns_an_empty_list(monkeypatch):
    monkeypatch.setattr(search, "_fetch", lambda query: None)
    assert search.youtube_search("octopus documentary") == []


@pytest.mark.parametrize("query", [None, 7, "", "   ", [], {}])
def test_bad_queries_return_an_empty_list(monkeypatch, query):
    def explode(value):  # must never be reached
        raise AssertionError("no fetch for an empty query")

    monkeypatch.setattr(search, "_fetch", explode)
    assert search.youtube_search(query) == []


def test_a_parser_bug_does_not_escape(monkeypatch, page):
    monkeypatch.setattr(search, "_walk", lambda node, out: (_ for _ in ()).throw(
        RuntimeError("parser bug")))
    assert search.youtube_search("octopus documentary") == []


# ---------------------------------------------------------------------------
# check_play_url — the URL matrix
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("http://youtube.com/watch?v=3GB-7qwwIp0&t=231s",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://youtu.be/3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://www.youtube.com/shorts/3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://www.youtube.com/embed/3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://www.youtube.com/live/3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://music.youtube.com/playlist?list=PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6",
     "https://www.youtube.com/playlist?list=PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6"),
    ("https://www.youtube-nocookie.com/embed/3GB-7qwwIp0",
     "https://www.youtube.com/watch?v=3GB-7qwwIp0"),
    ("https://example.org/films/octopus.mp4", "https://example.org/films/octopus.mp4"),
    ("http://example.org/a/b.webm?x=1", "http://example.org/a/b.webm?x=1"),
    ("https://example.org/live/index.m3u8", "https://example.org/live/index.m3u8"),
    ("https://example.org/clip.MOV", "https://example.org/clip.MOV"),
])
def test_accepted_play_urls_are_normalised(url, expected):
    result = search.check_play_url(url)
    assert result["ok"] is True, result
    assert result["url"] == expected


@pytest.mark.parametrize("url", [
    "",
    "   ",
    None,
    7,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.org/film.mp4",
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch?v=too-short",
    "https://youtu.be/",
    "https://youtu.be/not-an-id",
    "https://www.youtube.com/playlist?list=x",
    "https://example.org/film.mp3",
    "https://example.org/",
    "not a url",
])
def test_refused_play_urls_say_why(url):
    result = search.check_play_url(url)
    assert result["ok"] is False, url
    assert result["error"]


def test_watch_link_keeps_its_playlist_context():
    result = search.check_play_url(
        "https://www.youtube.com/watch?v=3GB-7qwwIp0&list=PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6")
    assert result["ok"] is True
    assert "list=PLyayDEcNvgueXmwaNc3dWXZY18EipwUD6" in result["url"]
