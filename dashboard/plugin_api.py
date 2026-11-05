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
import sys
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


# ---------------------------------------------------------------------------
# FastAPI routes mounted at /api/plugins/aura/
# ---------------------------------------------------------------------------

@router.get("/status")
def status() -> dict:
    return status_payload()


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
