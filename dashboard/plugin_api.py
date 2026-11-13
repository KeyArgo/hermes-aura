"""Aura Hermes Desktop dashboard API — the single port-discovery door (§5).

The desktop half and the agent tool must never guess a port, read a lease file
or start a second server. This module asks the *already imported* server module
for its live port and token, and forwards control calls to it.

Import strategy (follows REVamp's plugin glue): the plugin may be loaded as a
package (``aura``) or as a plain directory, so the server module is located by
scanning ``sys.modules`` first, then by relative/absolute import, and only as a
last resort by file path. Every path is guarded: this file must never raise
while the dashboard is mounting routes.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("aura.dashboard")

router = APIRouter()

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# locating the live server module (same object the agent process imported)
# ---------------------------------------------------------------------------

def _server_module():
    """Return the server module, preferring the already-imported instance."""
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        if name == "aura_core.server" or name.endswith(".aura_core.server"):
            return module
    for loader in (
        lambda: __import__("aura_core.server", fromlist=["server"]),
        lambda: __import__("aura.aura_core.server", fromlist=["server"]),
    ):
        try:
            return loader()
        except Exception:  # noqa: BLE001
            continue
    try:
        if str(_PLUGIN_ROOT) not in sys.path:
            sys.path.insert(0, str(_PLUGIN_ROOT))
        import aura_core.server as module  # noqa: F811
        return module
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: server module unavailable (%s)", type(exc).__name__)
        return None


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path("~/.hermes").expanduser()


def _file_token() -> str:
    try:
        return (_hermes_home() / "aura" / "token").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _enabled() -> bool:
    try:
        raw = json.loads((_hermes_home() / "aura" / "config.json").read_text(encoding="utf-8"))
        return bool(raw.get("enabled"))
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def _live():
    """``(server_module, port, token)`` with port/token possibly None."""
    server = _server_module()
    if server is None:
        return None, None, _file_token()
    port = None
    token = None
    try:
        port = server.get_port()
    except Exception:  # noqa: BLE001
        port = None
    if port is None:
        try:
            server.ensure_server()  # idempotent; same in-process singleton
            port = server.get_port()
        except Exception:  # noqa: BLE001
            port = None
    try:
        token = server.get_token()
    except Exception:  # noqa: BLE001
        token = None
    return server, port, token or _file_token()


# ---------------------------------------------------------------------------
# payload builders / forwarders (also callable from tests without FastAPI)
# ---------------------------------------------------------------------------

def status_payload() -> dict:
    """The §5 GET /status body."""
    try:
        server, port, token = _live()
        capture = "none"
        if server is not None:
            try:
                capture = server.get_capture()
            except Exception:  # noqa: BLE001
                capture = "none"
        url = f"http://127.0.0.1:{port}/?token={token}" if port else ""
        return {
            "ok": port is not None,
            "port": port,
            "url": url,
            "capture": capture,
            "enabled": _enabled(),
        }
    except Exception as exc:  # noqa: BLE001 - the door must always answer
        logger.info("aura dashboard: status failed (%s)", type(exc).__name__)
        return {"ok": False, "port": None, "url": "", "capture": "none", "enabled": False}


def control_payload(body: dict) -> tuple[int, dict]:
    """Forward ``body`` to the server's /api/control; ``(status, response)``."""
    try:
        _server, port, token = _live()
        if port is None:
            return 503, {"ok": False, "error": "server_not_running"}
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/control",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(data)),
                "Authorization": f"Bearer {token}",
                "Host": f"127.0.0.1:{port}",
            },
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
            return int(resp.status), payload
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            payload = {"ok": False, "error": "http_error"}
        return int(exc.code), payload
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: control forward failed (%s)", type(exc).__name__)
        return 502, {"ok": False, "error": "server_unreachable"}


def state_payload() -> dict:
    """Forward the server's /api/state — the desktop half's accent pulse reads this.

    Without this route the accent pulse silently degrades to no-op (L3 polls
    ``/state`` on the plugin_api proxy, not the server directly).
    """
    try:
        _server, port, token = _live()
        if port is None:
            return {"ok": False, "error": "server_not_running"}
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/state",
            headers={
                "Authorization": f"Bearer {token}",
                "Host": f"127.0.0.1:{port}",
            },
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
        if isinstance(payload, dict):
            payload.setdefault("ok", True)
        return payload
    except Exception as exc:  # noqa: BLE001 - the door must always answer
        logger.info("aura dashboard: state failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "server_unreachable"}


def _forward_json(path: str, body: dict | None = None,
                  timeout: float = 8.0) -> tuple[int, dict]:
    """Forward a call to the live server; ``(status, response)``. Never raises."""
    try:
        _server, port, token = _live()
        if port is None:
            return 503, {"ok": False, "error": "server_not_running"}
        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Host": f"127.0.0.1:{port}",
        }
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(data))
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=data,
            method="POST" if body is not None else "GET",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
            return int(resp.status), payload
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            payload = {"ok": False, "error": "http_error"}
        return int(exc.code), payload
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: %s forward failed (%s)", path, type(exc).__name__)
        return 502, {"ok": False, "error": "server_unreachable"}


def window_payload() -> dict:
    """``GET /window`` — is the film in its own OS window?"""
    _code, payload = _forward_json("/api/window", timeout=5.0)
    return payload


# ---------------------------------------------------------------------------
# FastAPI routes mounted at /api/plugins/aura/
# ---------------------------------------------------------------------------

@router.get("/status")
def status() -> dict:
    return status_payload()


@router.get("/state")
def state() -> dict:
    return state_payload()


@router.get("/player")
def player_status() -> dict:
    return _forward_json("/api/player", timeout=5.0)[1]


@router.get("/player/commands")
def player_commands(after: int = 0) -> dict:
    return _forward_json(f"/api/player/commands?after={max(0, after)}", timeout=5.0)[1]


@router.post("/player/report")
async def player_report(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "body_must_be_object"}, status_code=400)
    code, payload = _forward_json("/api/player/report", body, timeout=5.0)
    return JSONResponse(payload, status_code=code)


@router.post("/player/command")
async def player_command(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "body_must_be_object"}, status_code=400)
    code, payload = _forward_json("/api/player/command", body, timeout=5.0)
    return JSONResponse(payload, status_code=code)


# -- pop-out window ---------------------------------------------------------
# The desktop half calls these through ctx.rest('/window'…) — never the server
# directly (the plugin never guesses a port).

@router.get("/window")
def window_status() -> dict:
    return window_payload()


@router.post("/window/open")
async def window_open(request: Request) -> JSONResponse:
    try:
        body: Any = await request.json()
    except Exception:  # noqa: BLE001 - empty or malformed body
        body = {}
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "body_must_be_object"}, status_code=400)
    code, payload = _forward_json("/api/window/open", body, timeout=15.0)
    return JSONResponse(payload, status_code=code)


@router.post("/window/close")
async def window_close() -> JSONResponse:
    code, payload = _forward_json("/api/window/close", {}, timeout=15.0)
    return JSONResponse(payload, status_code=code)


def _version_dict() -> dict:
    """Which exact build is running: version, commit, dates, dirty, channel.

    Read through the vendored ``version_stamp`` (BUILD_INFO.json -> live git -> plugin.yaml),
    the same module the CLI and any other surface use, so the chip cannot disagree with them.
    """
    module = None
    for loader in (
        lambda: __import__("aura_core.version_stamp", fromlist=["version_stamp"]),
        lambda: __import__("aura.version_stamp", fromlist=["version_stamp"]),
    ):
        try:
            module = loader()
            break
        except Exception:  # noqa: BLE001 - try the next import shape
            continue
    if module is None:
        try:
            if str(_PLUGIN_ROOT) not in sys.path:
                sys.path.insert(0, str(_PLUGIN_ROOT))
            module = __import__("aura_core.version_stamp", fromlist=["version_stamp"])
        except Exception:  # noqa: BLE001 - a status line must always answer
            module = None
    if module is not None:
        try:
            info = module.as_dict()
            # The chip renders this line verbatim (VERSION-CHIP.md): one place
            # builds it, so every surface and the /version command agree.
            try:
                info = dict(info)
                info["line"] = module.chip_line(info)
            except Exception:  # noqa: BLE001 - an older vendored copy has no chip_line
                pass
            return info
        except Exception:  # noqa: BLE001
            logger.info("aura dashboard: version stamp unreadable", exc_info=True)
    return {"version": "unknown", "commit": "", "commit_short": "", "commit_date": "",
            "built_at": "", "channel": "release", "dirty": False, "source": "manifest",
            "line": "vunknown"}


@router.get("/version")
@router.get("/api/v1/version")
def version_route() -> dict:
    """The header chip's only source — never a number compiled into the desktop bundle."""
    return _version_dict()


# ---------------------------------------------------------------------------
# Playlist resolution
#
# A YouTube playlist embed starts at item #1, and if that item has embedding
# disabled the whole playlist shows "video unavailable". Listing the episodes
# lets Aura skip past such items instead of dying on them. Done here (not in the
# renderer) because the playlist page is cross-origin and sends no CORS headers.
# No API key: the public playlist page carries ytInitialData.
# ---------------------------------------------------------------------------

_PLAYLIST_CACHE: dict[str, tuple[float, list[dict]]] = {}
_PLAYLIST_TTL = 300.0
_LIST_RE = re.compile(r"[A-Za-z0-9_-]{10,64}")
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/124.0.0.0 Safari/537.36")
_INITIAL_DATA_RE = re.compile(r"ytInitialData\s*=\s*(\{.*\});</script>", re.S)


def _walkPlaylist(node: Any, out: list[dict]) -> None:
    if isinstance(node, dict):
        renderer = node.get("playlistVideoRenderer")
        if isinstance(renderer, dict):
            vid = renderer.get("videoId")
            title_obj = renderer.get("title") or {}
            title = ""
            runs = title_obj.get("runs") if isinstance(title_obj, dict) else None
            if isinstance(runs, list):
                title = "".join(str(part.get("text", "")) for part in runs if isinstance(part, dict))
            elif isinstance(title_obj, dict) and isinstance(title_obj.get("simpleText"), str):
                title = title_obj["simpleText"]
            length = ""
            length_obj = renderer.get("lengthText")
            if isinstance(length_obj, dict) and isinstance(length_obj.get("simpleText"), str):
                length = length_obj["simpleText"]
            if isinstance(vid, str) and len(vid) == 11:
                out.append({"videoId": vid, "title": title.strip()[:160], "length": length})
        # YouTube's newer playlist UI: `lockupViewModel` carries the same facts.
        lockup = node.get("lockupViewModel")
        if isinstance(lockup, dict):
            vid = lockup.get("contentId")
            title = ""
            meta = lockup.get("metadata") or {}
            lockup_meta = meta.get("lockupMetadataViewModel") if isinstance(meta, dict) else None
            if isinstance(lockup_meta, dict):
                title_obj = lockup_meta.get("title") or {}
                if isinstance(title_obj, dict) and isinstance(title_obj.get("content"), str):
                    title = title_obj["content"]
            length = ""
            image = lockup.get("contentImage") or {}
            thumb = image.get("thumbnailViewModel") if isinstance(image, dict) else None
            if isinstance(thumb, dict):
                for overlay in thumb.get("overlays") or []:
                    bottom = overlay.get("thumbnailBottomOverlayViewModel") if isinstance(overlay, dict) else None
                    for badge in (bottom or {}).get("badges") or []:
                        view = badge.get("thumbnailBadgeViewModel") if isinstance(badge, dict) else None
                        if isinstance(view, dict) and isinstance(view.get("text"), str) and view["text"]:
                            length = view["text"]
                            break
                    if length:
                        break
            if isinstance(vid, str) and len(vid) == 11:
                out.append({"videoId": vid, "title": title.strip()[:160], "length": length})
        for value in node.values():
            _walkPlaylist(value, out)
    elif isinstance(node, list):
        for value in node:
            _walkPlaylist(value, out)


def playlistItems(list_id: str) -> list[dict]:
    """Episodes of a playlist, newest fetch cached for 5 minutes. Never raises."""
    if not isinstance(list_id, str) or not _LIST_RE.fullmatch(list_id):
        return []
    now = time.time()
    hit = _PLAYLIST_CACHE.get(list_id)
    if hit and now - hit[0] < _PLAYLIST_TTL:
        return hit[1]
    request = urllib.request.Request(
        f"https://www.youtube.com/playlist?list={list_id}&hl=en",
        headers={"User-Agent": _UA, "Accept-Language": "en"}
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        html = response.read().decode("utf-8", "replace")
    match = _INITIAL_DATA_RE.search(html)
    if not match:
        return []
    data = json.loads(match.group(1))
    found: list[dict] = []
    _walkPlaylist(data, found)
    seen: set[str] = set()
    items: list[dict] = []
    for item in found:
        if item["videoId"] in seen:
            continue
        seen.add(item["videoId"])
        items.append(item)
    _PLAYLIST_CACHE[list_id] = (now, items)
    return items


@router.get("/playlist")
def playlist(id: str = "") -> dict:
    try:
        items = playlistItems(id)
    except Exception as exc:  # noqa: BLE001 - the door must always answer
        logger.info("aura dashboard: playlist failed (%s)", type(exc).__name__)
        return {"ok": False, "error": type(exc).__name__, "items": []}
    return {"ok": True, "items": items}


# ---------------------------------------------------------------------------
# [watch lane] YouTube search — "Hermes, find me something to watch"
#
# Same keyless trick as playlist resolution above, but driven by the shared
# ``aura_core.search`` module so the dashboard and the ``aura_watch`` tool can
# never disagree about a result. Runs in the dashboard process, so it calls the
# module directly — no loopback round trip, no token to carry.
# ---------------------------------------------------------------------------

def _search_module():
    """The aura_core.search module, preferring the already-imported instance."""
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        if name == "aura_core.search" or name.endswith(".aura_core.search"):
            return module
    for loader in (
        lambda: __import__("aura_core.search", fromlist=["search"]),
        lambda: __import__("aura.aura_core.search", fromlist=["search"]),
    ):
        try:
            return loader()
        except Exception:  # noqa: BLE001 - try the other import shape
            continue
    try:
        if str(_PLUGIN_ROOT) not in sys.path:
            sys.path.insert(0, str(_PLUGIN_ROOT))
        return __import__("aura_core.search", fromlist=["search"])
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: search module unavailable (%s)", type(exc).__name__)
        return None


def search_payload(q: str = "", limit: int = 6) -> dict:
    """Numbered YouTube results for ``q``; an outage is an empty list, not a 500."""
    module = _search_module()
    if module is None:
        return {"ok": False, "error": "search_unavailable", "items": []}
    try:
        wanted = int(limit)
    except (TypeError, ValueError):
        wanted = 6
    wanted = max(1, min(12, wanted))
    try:
        items = module.youtube_search(q, wanted)
    except Exception as exc:  # noqa: BLE001 - the door must always answer
        logger.info("aura dashboard: search failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "search_failed", "items": []}
    if not items:
        return {"ok": True, "query": str(q or ""), "count": 0, "items": [],
                "note": "Nothing came back; YouTube may be unreachable or nothing matched."}
    return {"ok": True, "query": str(q or ""), "count": len(items), "items": items}


@router.get("/search")
def search_route(q: str = "", limit: int = 6) -> dict:
    return search_payload(q, limit)


# ---------------------------------------------------------------------------
# [listen lane] Radio: search / popular / presets / favorites / resolve
#
# These are dashboard routes (mounted at /api/plugins/aura/radio/...) backed by
# aura_core.radio. They run in the dashboard process, so they can call the
# radio module directly — no loopback round trip, no token to carry.
# Every payload builder is callable without FastAPI (tests do exactly that),
# and none of them raise: an unreachable Radio Browser answers with the
# curated presets and a plain error string.
# ---------------------------------------------------------------------------

def _radio_module():
    """The aura_core.radio module, preferring the already-imported instance."""
    for name, module in list(sys.modules.items()):
        if module is None:
            continue
        if name == "aura_core.radio" or name.endswith(".aura_core.radio"):
            return module
    for loader in (
        lambda: __import__("aura_core.radio", fromlist=["radio"]),
        lambda: __import__("aura.aura_core.radio", fromlist=["radio"]),
    ):
        try:
            return loader()
        except Exception:  # noqa: BLE001 - try the other import shape
            continue
    try:
        if str(_PLUGIN_ROOT) not in sys.path:
            sys.path.insert(0, str(_PLUGIN_ROOT))
        return __import__("aura_core.radio", fromlist=["radio"])
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: radio module unavailable (%s)", type(exc).__name__)
        return None


def _preset_fallback(q: str = "", tag: str = "") -> list[dict]:
    """Curated presets, optionally narrowed by a substring match."""
    module = _radio_module()
    try:
        rows = module.presets() if module is not None else []
    except Exception:  # noqa: BLE001
        rows = []
    needle = (q or "").strip().lower()
    want = (tag or "").strip().lower()
    out = []
    for row in rows:
        name = str(row.get("name", "")).lower()
        tags = [str(t).lower() for t in row.get("tags") or []]
        if needle and needle not in name and not any(needle in t for t in tags):
            continue
        if want and not any(want in t for t in tags):
            continue
        out.append(row)
    return out


def radio_search_payload(q: str = "", tag: str = "", limit: int = 30) -> dict:
    """Stations matching ``q``/``tag``; presets are the outage fallback."""
    module = _radio_module()
    if module is None:
        return {"ok": False, "error": "radio_unavailable", "stations": [], "fallback": True}
    try:
        stations = module.search(q, tag, limit)
        return {"ok": True, "stations": stations, "source": "radiobrowser"}
    except module.RadioUnavailable as exc:
        logger.info("aura dashboard: radio search offline (%s)", type(exc).__name__)
        return {"ok": False, "error": "radio_unreachable", "stations": _preset_fallback(q, tag),
                "fallback": True}
    except module.RadioError as exc:
        return {"ok": False, "error": str(exc), "stations": [], "fallback": False}
    except Exception as exc:  # noqa: BLE001 - the door must always answer
        logger.info("aura dashboard: radio search failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "radio_failed", "stations": _preset_fallback(q, tag),
                "fallback": True}


def radio_popular_payload(limit: int = 24) -> dict:
    module = _radio_module()
    if module is None:
        return {"ok": False, "error": "radio_unavailable", "stations": _preset_fallback()}
    try:
        return {"ok": True, "stations": module.popular(limit)}
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: radio popular failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "radio_failed", "stations": _preset_fallback()}


def radio_presets_payload() -> dict:
    return {"ok": True, "stations": _preset_fallback()}


def radio_favorites_payload() -> dict:
    module = _radio_module()
    if module is None:
        return {"ok": False, "error": "radio_unavailable", "stations": []}
    try:
        return {"ok": True, "stations": module.favorites()}
    except module.RadioError as exc:
        return {"ok": False, "error": str(exc), "stations": []}
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: radio favorites failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "radio_failed", "stations": []}


def radio_favorite_add(body: Any) -> tuple[int, dict]:
    """POST /radio/favorites — add (or replace) one station. ``(status, body)``."""
    module = _radio_module()
    if module is None:
        return 503, {"ok": False, "error": "radio_unavailable"}
    if not isinstance(body, dict):
        return 400, {"ok": False, "error": "body_must_be_object"}
    try:
        station = module.add_favorite(body)
    except module.RadioError as exc:
        return 400, {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: favorite add failed (%s)", type(exc).__name__)
        return 500, {"ok": False, "error": "radio_failed"}
    return 200, {"ok": True, "station": station, "stations": radio_favorites_payload()["stations"]}


def radio_favorite_remove(sid: str) -> tuple[int, dict]:
    module = _radio_module()
    if module is None:
        return 503, {"ok": False, "error": "radio_unavailable"}
    if not isinstance(sid, str) or not sid.strip():
        return 400, {"ok": False, "error": "id_required"}
    try:
        removed = module.remove_favorite(sid.strip())
    except module.RadioError as exc:
        return 400, {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: favorite remove failed (%s)", type(exc).__name__)
        return 500, {"ok": False, "error": "radio_failed"}
    return (200 if removed else 404), {"ok": removed,
                                       "stations": radio_favorites_payload()["stations"]}


def radio_resolve_payload(url: str) -> dict:
    """.pls/.m3u -> the first public stream URL (validated, never a private host)."""
    module = _radio_module()
    if module is None:
        return {"ok": False, "error": "radio_unavailable", "url": ""}
    try:
        return {"ok": True, "url": module.prepare_stream(url)}
    except module.RadioError as exc:
        return {"ok": False, "error": str(exc), "url": ""}
    except Exception as exc:  # noqa: BLE001
        logger.info("aura dashboard: radio resolve failed (%s)", type(exc).__name__)
        return {"ok": False, "error": "radio_failed", "url": ""}


@router.get("/radio/search")
def radio_search(q: str = "", tag: str = "", limit: int = 30) -> dict:
    return radio_search_payload(q, tag, limit)


@router.get("/radio/popular")
def radio_popular(limit: int = 24) -> dict:
    return radio_popular_payload(limit)


@router.get("/radio/presets")
def radio_presets() -> dict:
    return radio_presets_payload()


@router.get("/radio/favorites")
def radio_favorites() -> dict:
    return radio_favorites_payload()


@router.post("/radio/favorites")
async def radio_favorite_create(request: Request) -> JSONResponse:
    try:
        body: Any = await request.json()
    except Exception:  # noqa: BLE001 - empty or malformed body
        body = {}
    code, payload = radio_favorite_add(body)
    return JSONResponse(payload, status_code=code)


@router.delete("/radio/favorites")
def radio_favorite_delete(id: str = "") -> JSONResponse:
    code, payload = radio_favorite_remove(id)
    return JSONResponse(payload, status_code=code)


@router.get("/radio/resolve")
def radio_resolve(url: str = "") -> dict:
    return radio_resolve_payload(url)


@router.post("/control")
async def control(request: Request) -> JSONResponse:
    try:
        body: Any = await request.json()
    except Exception:  # noqa: BLE001 - empty or malformed body
        body = {}
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "body_must_be_object"}, status_code=400)
    code, payload = control_payload(body)
    return JSONResponse(payload, status_code=code)
