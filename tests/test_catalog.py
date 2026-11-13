"""The Aura shelf catalogue: the committed file, its server route, the dashboard
mirror, and ``aura_watch action=browse``.

No network: the generator's archive.org rule is exercised with a fake HEAD, and
browse reads the committed file the way the plugin does.

Run: python3 -m pytest tests/test_catalog.py -q
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CATALOG_FILE = ROOT / "web" / "catalog.json"

REQUIRED_CATEGORIES = [
    "Deep sea & oceans",
    "Nature & wildlife",
    "Space & astronomy",
    "Earth from above",
    "Slow TV",
    "Classic films",
    "Classic cartoons",
    "Anime",
    "Open movies",
    "Science & history docs",
    "Ambience",
]


def _catalog() -> list[dict]:
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def _load_plugin():
    name = "aura_catalog_plugin"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_builder():
    spec = importlib.util.spec_from_file_location("aura_build_catalog", ROOT / "tools" / "build_catalog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# the file
# ---------------------------------------------------------------------------

def test_catalog_file_is_a_well_formed_list():
    items = _catalog()
    assert isinstance(items, list) and items, "web/catalog.json is missing or empty"
    fields = {"category", "title", "year", "url", "licence", "note", "duration_s"}
    for entry in items:
        assert isinstance(entry, dict), entry
        assert set(entry) == fields, f"unexpected fields: {sorted(set(entry) ^ fields)}"
        assert isinstance(entry["category"], str) and entry["category"], entry
        assert isinstance(entry["title"], str) and entry["title"].strip(), entry
        assert isinstance(entry["url"], str) and entry["url"].startswith("https://"), entry
        assert isinstance(entry["licence"], str) and entry["licence"].strip(), entry
        assert isinstance(entry["note"], str) and entry["note"].strip(), entry
        assert entry["year"] is None or (isinstance(entry["year"], int) and 1800 <= entry["year"] <= 2100), entry
        assert entry["duration_s"] is None or (isinstance(entry["duration_s"], int) and entry["duration_s"] > 0), entry


def test_catalog_urls_are_unique():
    items = _catalog()
    urls = [entry["url"] for entry in items]
    assert len(set(urls)) == len(urls), "two catalogue titles share a url"


def test_every_category_is_present_and_non_empty_in_the_shelf_order():
    items = _catalog()
    seen: list[str] = []
    for entry in items:
        if not seen or seen[-1] != entry["category"]:
            seen.append(entry["category"])
    assert seen == REQUIRED_CATEGORIES, f"categories are not in shelf order: {seen}"
    for category in REQUIRED_CATEGORIES:
        assert any(entry["category"] == category for entry in items), f"{category} has no titles"
    assert len(items) == 346, f"expected the 346 verified rows, found {len(items)}"


def test_generator_switches_a_multi_gigabyte_master_only_for_a_real_smaller_derivative():
    builder = _load_builder()
    original = "https://archive.org/download/big-item-1928/big-item-1928.mp4"
    derivative = "https://archive.org/download/big-item-1928/big-item-1928.ia.mp4"
    fake = "https://archive.org/download/big-item-1928/big-item-1928_512kb.mp4"

    def head(url):
        answers = {
            original: {"status": 200, "content_type": "video/mp4", "content_length": 4_000_000_000},
            # archive.org serves the original for a derivative name that does not
            # exist; the size check must refuse it rather than "switch" to it.
            fake: {"status": 200, "content_type": "video/mp4", "content_length": 4_000_000_000},
            derivative: {"status": 200, "content_type": "video/mp4", "content_length": 900_000_000},
        }
        return answers[url]

    cache: dict = {}
    assert builder.resolve_url(original, head, cache) == derivative

    # No usable derivative: keep the master rather than invent a URL.
    def head_without_derivative(url):
        return {"status": 200, "content_type": "video/mp4", "content_length": 4_000_000_000}

    assert builder.resolve_url(original, head_without_derivative, {}) == original

    # Under the limit: the master is kept even when a derivative exists.
    def head_small(url):
        return {"status": 200, "content_type": "video/mp4", "content_length": 1_500_000_000}

    assert builder.resolve_url(original, head_small, {}) == original


# ---------------------------------------------------------------------------
# the server route
# ---------------------------------------------------------------------------

def _http(port, path, token=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    conn.request("GET", path, headers=headers)
    response = conn.getresponse()
    payload = response.read()
    conn.close()
    return response.status, payload


@pytest.fixture()
def live(tmp_path, monkeypatch):
    from aura_core import server

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AURA_CAPTURE", "none")
    server.stop_server()
    server.ensure_server()
    port, token = server.get_port(), server.get_token()
    assert port and token, "server did not start"
    server._CATALOG_CACHE = None
    try:
        yield {"port": port, "token": token}
    finally:
        server.stop_server()


def test_api_catalog_returns_the_committed_file(live):
    status, payload = _http(live["port"], "/api/catalog", token=live["token"])
    assert status == 200
    body = json.loads(payload)
    assert body["ok"] is True
    assert body["count"] == len(_catalog())
    assert body["items"] == _catalog()


def test_api_catalog_stays_behind_the_token(live):
    status, _ = _http(live["port"], "/api/catalog")
    assert status == 401


# ---------------------------------------------------------------------------
# the dashboard mirror
# ---------------------------------------------------------------------------

@pytest.fixture()
def dashboard(monkeypatch):
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
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    monkeypatch.setitem(sys.modules, "fastapi.responses", responses)
    monkeypatch.delitem(sys.modules, "dashboard.plugin_api", raising=False)
    import importlib
    module = importlib.import_module("dashboard.plugin_api")
    module.__dict__["_CATALOG_ROUTES"] = routes
    return module


def test_dashboard_registers_catalog_and_forwards_the_server_payload(dashboard, monkeypatch):
    seen: list[str] = []

    def forward(path, body=None, timeout=5.0):
        seen.append(path)
        payload = {"ok": True, "count": 2, "items": [{"title": "Detour"}, {"title": "Speedy"}]}
        return 200, payload

    monkeypatch.setattr(dashboard, "_forward_json", forward)
    payload = dashboard.catalog()
    assert seen == ["/api/catalog"], seen
    assert payload["count"] == 2 and len(payload["items"]) == 2
    assert ("GET", "/catalog") in {(method, path) for method, path, _ in dashboard._CATALOG_ROUTES}


# ---------------------------------------------------------------------------
# aura_watch action=browse
# ---------------------------------------------------------------------------

@pytest.fixture()
def plugin():
    return _load_plugin()


def _browse(p, **args):
    payload = json.loads(p._tool_aura_watch({"action": "browse", **args}))
    assert isinstance(payload, dict)
    return payload


def test_browse_is_a_declared_action_with_its_own_arguments(plugin):
    assert "browse" in plugin._WATCH_ACTIONS
    schema = plugin.SCHEMA_AURA_WATCH
    assert "browse" in schema["parameters"]["properties"]["action"]["enum"]
    assert "category" in schema["parameters"]["properties"]
    assert "query" in schema["parameters"]["properties"]
    assert "catalogue" in schema["description"].lower()


def test_browse_by_category_returns_up_to_ten_matches(plugin, monkeypatch):
    monkeypatch.setattr(plugin._search, "youtube_search",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("browse went to the network")))
    payload = _browse(plugin, category="Anime")
    assert payload["ok"] is True
    assert 1 <= payload["count"] <= plugin._WATCH_BROWSE_LIMIT
    assert all(item["category"] == "Anime" for item in payload["items"])
    for item in payload["items"]:
        assert set(item) == {"n", "title", "year", "category", "url"}
        assert item["url"].startswith("https://")
    assert all(line.startswith(f"{item['n']}. ") for line, item in zip(payload["text"].splitlines(), payload["items"]))


def test_browse_by_query_finds_titles_by_their_description(plugin):
    payload = _browse(plugin, query="noir")
    assert payload["ok"] is True and payload["count"] > 0
    catalogue = {(entry["title"], entry["url"]) for entry in _catalog()}
    for item in payload["items"]:
        assert (item["title"], item["url"]) in catalogue
        assert "noir" in f"{item['title']} {item['category']}".lower() or \
            "noir" in next(e["note"] for e in _catalog() if e["url"] == item["url"]).lower()


def test_browse_with_neither_argument_lists_the_categories(plugin):
    payload = _browse(plugin)
    assert payload["ok"] is True
    assert payload["count"] == len(_catalog())
    assert [c["category"] for c in payload["categories"]] == REQUIRED_CATEGORIES
    assert sum(c["count"] for c in payload["categories"]) == len(_catalog())


def test_browse_says_so_plainly_when_nothing_matches(plugin):
    payload = _browse(plugin, query="zzzz-not-in-the-catalogue")
    assert payload["ok"] is True
    assert payload["count"] == 0 and payload["items"] == []
    assert "hint" in payload and payload["text"] == ""


def test_browse_rejects_a_non_string_argument(plugin):
    payload = _browse(plugin, category=7)
    assert payload["ok"] is False
    assert "category" in payload["error"]
