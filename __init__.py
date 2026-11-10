"""Aura — Hermes plugin glue (L4).

Registers the ``aura_control`` tool and the observer hooks that translate agent
activity into mood transitions, then hands those transitions to
``aura_core.server.publish_mood`` (CONTRACT.md §4 and §7).

Design rules, all enforced below:

* Runtime is pure Python stdlib.
* Every hook is an observer: it returns ``None``, swallows its own exceptions,
  and can never block or alter an agent turn.
* ``register()`` never blocks: the server is warmed from a daemon thread, and
  the core is imported eagerly (a lazily-importing daemon thread can run after
  the loader has torn the package namespace down).
* The token never reaches tool output: every URL shown to the model is passed
  through ``aura_core.redact.redact_url`` (or a local masker when that module
  is not present yet).
* Config ``enabled: false`` is a kill switch: every hook becomes a no-op and
  the mood machine is reset.
"""

from __future__ import annotations

import functools
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger("aura")

TOOLSET = "aura"

# Eager core import.  Two forms because Hermes loads plugins both as packages
# (relative import) and as plain directories (absolute import).
try:
    from .aura_core import mood as _mood, server as _server
except ImportError:  # loaded as a plain directory, not a package
    try:
        from aura_core import mood as _mood, server as _server
    except ImportError:  # core not installed yet; degrade to no-ops
        _mood = None  # type: ignore[assignment]
        _server = None  # type: ignore[assignment]

try:
    from .aura_core.redact import redact_url as _redact_url
except ImportError:
    try:
        from aura_core.redact import redact_url as _redact_url
    except ImportError:
        _redact_url = None  # type: ignore[assignment]

_MOODS = tuple(getattr(_mood, "MOODS", ())) if _mood is not None else ()
_MACHINE = _mood.MoodMachine() if _mood is not None else None

_TOKEN_RE = re.compile(r"(token=)([^&#\s]+)")
_TOKEN_FILE = ("aura", "token")


class _Config:
    """Local mirror of the plugin kill switch / intensity cap."""

    enabled = True
    intensity_cap = 1.0


_CFG = _Config()
_CTX: Any = None
_ACTIONS = ("on", "off", "status", "intensity", "preset", "mood",
            "pause", "resume", "next", "prev", "seek", "popout", "popin")


# ---------------------------------------------------------------------------
# server helpers (CONTRACT.md §7 — L4 calls only these)
# ---------------------------------------------------------------------------

def _ensure() -> None:
    if _server is None:
        return
    ensure_server = getattr(_server, "ensure_server", None)
    if ensure_server is None:
        return
    ensure_server()


def _boot() -> None:
    # Background start at load time.  A host that forbids sockets (Plugin
    # Doctor, sandboxes) must not print a traceback; the first tool call retries.
    try:
        if _CFG.enabled:
            _ensure()
    except Exception as exc:  # noqa: BLE001
        logger.info("aura: server not started at load (%s); will retry on first use", exc)


def _port() -> int | None:
    if _server is None:
        return None
    get_port = getattr(_server, "get_port", None)
    if get_port is None:
        return None
    try:
        port = get_port()
    except Exception:  # noqa: BLE001
        return None
    if not port:
        return None
    try:
        return int(port)
    except (TypeError, ValueError):
        return None


def _publish(state) -> None:
    """Hand one transition to the server; never raises into a hook."""
    if _server is None or state is None:
        return
    publish_mood = getattr(_server, "publish_mood", None)
    if publish_mood is None:
        return
    try:
        publish_mood(str(state.mood), float(state.intensity), int(state.ttl_ms))
    except Exception:  # noqa: BLE001 — a closed socket must not break a turn
        logger.debug("aura: publish_mood failed", exc_info=True)


def _publish_config() -> None:
    if _server is None:
        return
    fn = getattr(_server, "publish_config", None)
    if fn is not None:
        fn()


def _transition(mood: str, **kwargs):
    if _MACHINE is None:
        return None
    state = _MACHINE.set(mood, **kwargs)
    _publish(state)
    return state


# ---------------------------------------------------------------------------
# token / redaction / HTTP (never guess a port)
# ---------------------------------------------------------------------------

def _token_path() -> Path:
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    return base.joinpath(*_TOKEN_FILE)


def _token() -> str | None:
    try:
        value = _token_path().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _mask_url(url: str) -> str:
    """Redact the token from a URL before it reaches the model."""
    text = str(url)
    if _redact_url is not None:
        try:
            return _redact_url(text)
        except Exception:  # noqa: BLE001
            pass
    return _TOKEN_RE.sub(r"\1***", text)


def _public_url(port: int) -> str:
    token = _token()
    url = f"http://127.0.0.1:{int(port)}/"
    if token:
        url += f"?token={token}"
    return _mask_url(url)


def _request(method: str, path: str, body: dict | None = None,
             timeout: float = 2.0) -> dict:
    """Call the live server.  The port comes from ``get_port()`` only."""
    port = _port()
    if not port:
        raise RuntimeError("server not running")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    try:
        parsed = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _get(path: str) -> dict:
    try:
        return _request("GET", path)
    except Exception:  # noqa: BLE001
        return {}


def _control(body: dict) -> dict:
    return _request("POST", "/api/control", body=body)


# ---------------------------------------------------------------------------
# config / kill switch
# ---------------------------------------------------------------------------

def _set_enabled(flag: bool) -> None:
    """Kill switch.  Enabling and disabling both start from a clean idle."""
    _CFG.enabled = bool(flag)
    if _MACHINE is not None:
        _MACHINE.reset()


def _persist_enabled(flag: bool) -> None:
    ctx = _CTX
    if ctx is None:
        return
    set_config = getattr(ctx, "set_config", None)
    if set_config is None:
        return
    try:
        set_config("enabled", bool(flag))
    except Exception:  # noqa: BLE001 — managed installs may refuse writes
        pass


# ---------------------------------------------------------------------------
# hooks — observers only; never raise, never return a dict
# ---------------------------------------------------------------------------

def _safe(fn):
    @functools.wraps(fn)
    def guarded(**kwargs):
        try:
            if not _CFG.enabled or _MACHINE is None:
                return None
            fn(**kwargs)
        except Exception:  # noqa: BLE001 — a hook must never break the turn
            logger.warning("aura: hook %s failed", fn.__name__, exc_info=True)
        return None

    return guarded


@_safe
def _hook_session_start(**kw) -> None:
    # A fresh session starts at idle; nothing from a previous session survives.
    _MACHINE.reset()
    _transition("idle")


@_safe
def _hook_session_end(**kw) -> None:
    _MACHINE.reset()
    _transition("idle")


@_safe
def _hook_pre_tool_call(**kw) -> None:
    _transition("tool")


@_safe
def _hook_post_tool_call(**kw) -> None:
    error_message = kw.get("error_message")
    status = str(kw.get("status") or "").strip().lower()
    failed = bool(error_message) or status in ("error", "failed", "failure") \
        or kw.get("ok") is False
    _transition("error" if failed else "thinking")


@_safe
def _hook_pre_approval_request(**kw) -> None:
    _transition("approval")


@_safe
def _hook_post_approval_response(**kw) -> None:
    # Only an active approval needs clearing; otherwise this is a no-op.
    if _MACHINE.snapshot().mood == "approval":
        _publish(_MACHINE.clear("approval"))


@_safe
def _hook_api_request_error(**kw) -> None:
    _transition("error")


@_safe
def _hook_on_stream_start(**kw) -> None:
    _transition("streaming")


@_safe
def _hook_on_stream_end(**kw) -> None:
    _transition("done")


@_safe
def _hook_subagent_start(**kw) -> None:
    _transition("thinking")


@_safe
def _hook_subagent_stop(**kw) -> None:
    _transition("thinking")


HOOKS = (
    ("on_session_start", _hook_session_start),
    ("on_session_end", _hook_session_end),
    ("pre_tool_call", _hook_pre_tool_call),
    ("post_tool_call", _hook_post_tool_call),
    ("pre_approval_request", _hook_pre_approval_request),
    ("post_approval_response", _hook_post_approval_response),
    ("api_request_error", _hook_api_request_error),
    ("on_stream_start", _hook_on_stream_start),
    ("on_stream_end", _hook_on_stream_end),
    ("subagent_start", _hook_subagent_start),
    ("subagent_stop", _hook_subagent_stop),
)


# ---------------------------------------------------------------------------
# aura_control tool
# ---------------------------------------------------------------------------

def _dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _bad(message: str) -> dict:
    return {"ok": False, "error": message, "allowed_actions": list(_ACTIONS)}


def _status_payload() -> dict:
    port = _port()
    state = _MACHINE.snapshot() if _MACHINE is not None else None
    mood = state.mood if state is not None else "idle"
    intensity = state.intensity if state is not None else 0.0
    if not port:
        return {
            "ok": False,
            "running": False,
            "enabled": _CFG.enabled,
            "port": None,
            "capture": "none",
            "mood": mood,
            "intensity": intensity,
            "error": "server not running",
            "hint": "Aura starts on first use; call aura_control action=on "
                    "or let a hook start it, then retry status.",
        }
    payload = {
        "ok": True,
        "running": True,
        "enabled": _CFG.enabled,
        "port": port,
        "capture": "none",
        "mood": mood,
        "intensity": intensity,
        "url": _public_url(port),
    }
    health = _get("/healthz")
    if health:
        payload["capture"] = health.get("capture") or "none"
        if "version" in health:
            payload["version"] = health.get("version")
    live = _get("/api/state")
    if live:
        payload["enabled"] = bool(live.get("enabled", payload["enabled"]))
        if isinstance(live.get("mood"), str):
            payload["mood"] = live["mood"]
        try:
            payload["intensity"] = round(float(live.get("intensity")), 4)
        except (TypeError, ValueError):
            pass
    if state is not None:
        payload["pulse_hz"] = state.pulse_hz
        payload["flash_allowed"] = state.flash_allowed
        payload["ttl_ms"] = state.ttl_ms
    # The film, so "what is playing?" is one call: last report + window state.
    payload["film"] = _player_snapshot()
    return payload


def _toggle(flag: bool) -> dict:
    _set_enabled(flag)
    _persist_enabled(flag)
    try:
        _ensure()
    except Exception:  # noqa: BLE001
        pass
    applied = None
    control_error = None
    try:
        applied = _control({"enabled": bool(flag)})
        _publish_config()
    except Exception as exc:  # noqa: BLE001
        control_error = f"{type(exc).__name__}: {exc}"
    payload = _status_payload()
    payload["ok"] = True
    payload["enabled"] = bool(flag)
    if applied is not None:
        payload["applied"] = applied
    if control_error:
        payload["control_error"] = control_error
    return payload


def _action_status() -> dict:
    return _status_payload()


# ---------------------------------------------------------------------------
# the film: Hermes is the remote (transport, pop-out)
# ---------------------------------------------------------------------------

def _player_snapshot() -> dict:
    """What the active player last reported, plus the window's status."""
    snapshot: dict = {}
    player = _get("/api/player")
    if isinstance(player, dict) and player:
        snapshot["player"] = player.get("player") if isinstance(player.get("player"), dict) else {}
        if "seq" in player:
            snapshot["command_seq"] = player.get("seq")
    window = _get("/api/window")
    if isinstance(window, dict) and window:
        snapshot["window"] = window
    return snapshot


def _action_transport(action: str, args: dict) -> dict:
    """Queue one transport command on the server; the active player applies it."""
    body: dict = {"cmd": action}
    if action == "seek":
        raw = args.get("position")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return _bad("seek needs position (seconds) as a number")
        body["value"] = max(0.0, float(raw))
    try:
        result = _request("POST", "/api/player/command", body=body)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": "Aura's server is not running; call action=status."}
    if not isinstance(result, dict) or result.get("ok") is not True:
        return {"ok": False, "error": (result or {}).get("error", "command_rejected"),
                "command": action}
    payload = {"ok": True, "command": action, "seq": result.get("seq")}
    payload.update(_player_snapshot())
    return payload


def _action_popout(args: dict) -> dict:
    """Open the film's own OS window (optionally at a given position)."""
    body: dict = {}
    url = args.get("url")
    if isinstance(url, str) and url.strip():
        body["url"] = url.strip()
    raw = args.get("position")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        body["position"] = max(0.0, float(raw))
    try:
        result = _request("POST", "/api/window/open", body=body, timeout=20.0)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": "Aura's server is not running; call action=status."}
    if not isinstance(result, dict):
        return {"ok": False, "error": "no_answer"}
    if result.get("ok") is not True:
        return {"ok": False, "error": result.get("error", "window_failed"),
                "window": result.get("window", {})}
    return {
        "ok": True,
        "open": True,
        "already": bool(result.get("already")),
        "hint": "The film now plays in its own window; tell me pause, next "
                "episode or popin to bring it back.",
    }


def _action_popin() -> dict:
    try:
        result = _request("POST", "/api/window/close", body={}, timeout=20.0)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": "Aura's server is not running; call action=status."}
    if not isinstance(result, dict) or result.get("ok") is not True:
        return {"ok": False, "error": (result or {}).get("error", "window_failed")}
    return {"ok": True, "closed": bool(result.get("closed")),
            "window": result.get("window", {})}


def _action_intensity(args: dict) -> dict:
    raw = args.get("intensity")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return _bad("intensity must be a number between 0 and 1")
    value = float(raw)
    if not 0.0 <= value <= 1.0:
        return _bad("intensity must be between 0 and 1")
    if _MACHINE is not None:
        _MACHINE.set_cap(value)
    _CFG.intensity_cap = value
    payload = {"ok": True, "intensity": value}
    try:
        payload["applied"] = _control({"intensity": value})
        _publish_config()
    except Exception as exc:  # noqa: BLE001
        payload["running"] = False
        payload["control_error"] = f"{type(exc).__name__}: {exc}"
    return payload


def _action_preset(args: dict) -> dict:
    raw = args.get("preset")
    if raw is not None and not isinstance(raw, str):
        return _bad("preset must be a string or null")
    preset = None if raw is None else str(raw).strip()
    if preset == "":
        preset = None
    payload = {"ok": True, "preset": preset}
    try:
        payload["applied"] = _control({"preset": preset})
        _publish_config()
    except Exception as exc:  # noqa: BLE001
        payload["running"] = False
        payload["control_error"] = f"{type(exc).__name__}: {exc}"
    return payload


def _action_mood(args: dict) -> dict:
    raw = args.get("mood")
    if not isinstance(raw, str) or raw.strip().lower() not in _MOODS:
        return {"ok": False, "error": f"mood must be one of {list(_MOODS)}",
                "allowed_moods": list(_MOODS)}
    mood = raw.strip().lower()
    if _MACHINE is None:
        return {"ok": False, "error": "mood machine unavailable"}
    state = _MACHINE.set(mood)
    _publish(state)
    return {
        "ok": True,
        "mood": state.mood,
        "intensity": state.intensity,
        "ttl_ms": state.ttl_ms,
        "pulse_hz": state.pulse_hz,
        "flash_allowed": state.flash_allowed,
        "running": _port() is not None,
    }


def _tool_aura_control(args: dict, **kw) -> str:
    """aura_control — turn Aura on/off, read status, set intensity/preset/mood."""
    try:
        if not isinstance(args, dict):
            return _dump(_bad("arguments must be an object"))
        action = str(args.get("action") or "status").strip().lower()
        if action not in _ACTIONS:
            return _dump(_bad(f"unknown action {action!r}"))
        if action == "status":
            payload = _action_status()
        elif action == "on":
            payload = _toggle(True)
        elif action == "off":
            payload = _toggle(False)
        elif action == "intensity":
            payload = _action_intensity(args)
        elif action == "preset":
            payload = _action_preset(args)
        elif action == "mood":
            payload = _action_mood(args)
        elif action in ("pause", "resume", "next", "prev", "seek"):
            payload = _action_transport("play" if action == "resume" else action, args)
        elif action == "popout":
            payload = _action_popout(args)
        else:  # popin
            payload = _action_popin()
        return _dump(payload)
    except Exception as exc:  # noqa: BLE001 — a tool must always answer
        return _dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


SCHEMA_AURA_CONTROL = {
    "name": "aura_control",
    "description": (
        "Control Aura, the local audio-reactive visualizer and living theme for "
        "Hermes Desktop — and the film it is playing. action=status reports whether "
        "the server is running, its port, capture backend, current mood and "
        "intensity, a redacted URL, and what the film is doing (film.player: url, "
        "title, playing, position, duration; film.window: open). action=on/off "
        "toggles Aura; intensity sets the 0..1 cap; preset picks a visualizer "
        "preset (null = server default); mood sets the agent mood (idle, thinking, "
        "tool, approval, error, streaming, done). Transport of the active player "
        "(in-app or its own window): action=pause, resume, next, prev, or seek "
        "with position in seconds. action=popout moves the film into its own OS "
        "window (another monitor / full screen) and action=popin closes it; "
        "optional url and position choose what to open. Use these when the user "
        "says 'pause', 'next episode', 'play the octopus documentary' or 'put it "
        "on my other screen'. Returns JSON. Never blocks the turn; if the server "
        "is not running it says so plainly."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(_ACTIONS),
                "description": "What to do (default status).",
            },
            "intensity": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "for intensity: cap 0..1",
            },
            "preset": {
                "type": ["string", "null"],
                "description": "for preset: preset name, or null for the default",
            },
            "mood": {
                "type": "string",
                "enum": list(_MOODS),
                "description": "for mood: the mood to display",
            },
            "position": {
                "type": "number",
                "minimum": 0.0,
                "description": "for seek: absolute position in seconds; for "
                               "popout: where the window should start",
            },
            "url": {
                "type": "string",
                "description": "for popout: the film to open (defaults to the "
                               "one already loaded)",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}

TOOLS = (
    ("aura_control", SCHEMA_AURA_CONTROL, _tool_aura_control),
)


# ---------------------------------------------------------------------------
# plugin entry point
# ---------------------------------------------------------------------------

def register(ctx: Any) -> None:
    """Register the aura_control tool and the mood observer hooks."""
    global _CTX
    _CTX = ctx

    try:
        enabled = ctx.get_config("enabled", True)
        _CFG.enabled = bool(enabled)
    except Exception:  # noqa: BLE001
        _CFG.enabled = True

    try:
        cap = ctx.get_config("intensity", 1.0)
        if _MACHINE is not None and isinstance(cap, (int, float)) \
                and not isinstance(cap, bool):
            _CFG.intensity_cap = max(0.0, min(1.0, float(cap)))
            _MACHINE.set_cap(_CFG.intensity_cap)
    except Exception:  # noqa: BLE001
        pass

    if not _CFG.enabled and _MACHINE is not None:
        _MACHINE.reset()

    for name, schema, handler in TOOLS:
        try:
            ctx.register_tool(name=name, toolset=TOOLSET, schema=schema,
                              handler=handler)
        except TypeError:
            # Older cores: positional name/schema/handler without toolset.
            ctx.register_tool(name=name, schema=schema, handler=handler)

    for hook_name, fn in HOOKS:
        ctx.register_hook(hook_name, fn)

    # Warm the server without blocking register().
    threading.Thread(target=_boot, name="aura-boot", daemon=True).start()
    logger.info("aura registered (%d tool, %d hooks)", len(TOOLS), len(HOOKS))


__all__ = ["register"]
