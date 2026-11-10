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


# ---------------------------------------------------------------------------
# FastAPI routes mounted at /api/plugins/aura/
# ---------------------------------------------------------------------------

@router.get("/status")
def status() -> dict:
    return status_payload()


@router.get("/state")
def state() -> dict:
    return state_payload()


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
            return module.as_dict()
        except Exception:  # noqa: BLE001
            logger.info("aura dashboard: version stamp unreadable", exc_info=True)
    return {"version": "unknown", "commit": "", "commit_short": "", "commit_date": "",
            "built_at": "", "channel": "release", "dirty": False, "source": "manifest"}


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
