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
import urllib.parse
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

# [listen lane] Internet radio + stream safety. Optional: without it the
# aura_listen tool still answers, it just cannot search.
try:
    from .aura_core import radio as _radio
except ImportError:  # loaded as a plain directory, not a package
    try:
        from aura_core import radio as _radio
    except ImportError:
        _radio = None  # type: ignore[assignment]

# [watch lane] Keyless YouTube search + play-URL validation. Optional: without
# it aura_watch says so instead of raising.
try:
    from .aura_core import search as _search
except ImportError:  # loaded as a plain directory, not a package
    try:
        from aura_core import search as _search
    except ImportError:
        _search = None  # type: ignore[assignment]

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
            "pause", "resume", "next", "prev", "seek", "captions",
            "popout", "popout_inline", "popin")


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
    """``<hermes home>/aura/token`` for the ACTIVE profile.

    Resolved through ``aura_core.config.hermes_home()`` rather than a bare
    ``os.environ["HERMES_HOME"]``: the helper follows a context-local override,
    so a tool call inside a non-default profile reads that profile's token
    instead of whichever home the environment happened to export at boot.
    """
    # Absolute first: the rest of the plugin and the tests import `aura_core`
    # that way, and a relative import here would build a second, patched-only
    # module instance whose hermes_home() nobody else can see.
    try:
        from aura_core import config as _config
    except ImportError:
        try:
            from .aura_core import config as _config
        except ImportError:
            _config = None
    if _config is not None:
        try:
            return _config.hermes_home().joinpath(*_TOKEN_FILE)
        except Exception:  # noqa: BLE001 - never fail a tool call over a path
            pass
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
        # [savelist lane] The desktop reports the owner's saved library with
        # its player report; ``None`` means it has not reported one yet.
        library = player.get("library")
        snapshot["library"] = library if isinstance(library, list) else None
    window = _get("/api/window")
    if isinstance(window, dict) and window:
        snapshot["window"] = window
    return snapshot


def _action_transport(action: str, args: dict, extra: dict | None = None,
                      hint: str | None = None) -> dict:
    """Queue one transport command on the server; the active player applies it."""
    body: dict = {"cmd": action}
    if extra:
        body.update(extra)
    if action == "seek":
        raw = args.get("position")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return _bad("seek needs position (seconds) as a number")
        body["value"] = max(0.0, float(raw))
    try:
        result = _request("POST", "/api/player/command", body=body)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": hint or "Aura's server is not running; call action=status."}
    if not isinstance(result, dict) or result.get("ok") is not True:
        return {"ok": False, "error": (result or {}).get("error", "command_rejected"),
                "command": action}
    payload = {"ok": True, "command": action, "seq": result.get("seq"), "delivery": "queued"}
    snapshot = _player_snapshot()
    # The saved library is not player state: it would only bloat every
    # transport result. action=save/remove/list read it for themselves.
    snapshot.pop("library", None)
    payload.update(snapshot)
    player = payload.get("player")
    if isinstance(player, dict):
        # The player reports on its next tick; the status call a moment later
        # carries this. Surface it here too when it is already known.
        if isinstance(player.get("applied"), bool):
            payload["applied"] = player["applied"]
        if isinstance(player.get("last_command"), str) and player["last_command"]:
            payload["last_command"] = player["last_command"]
    return payload


def _action_captions(args: dict) -> dict:
    """Turn the film's subtitles on or off (action=captions).

    The switch is queued like every other transport verb, so it reaches
    whichever player owns the picture — the in-app frame or its own window —
    and the desktop half remembers the choice for the next film.
    """
    raw = args.get("captions")
    if isinstance(raw, bool):
        on = raw
    elif isinstance(raw, str) and raw.strip().lower() in ("on", "off", "true", "false", "1", "0"):
        on = raw.strip().lower() in ("on", "true", "1")
    else:
        return {"ok": False, "error": "captions needs on or off",
                "allowed_actions": list(_ACTIONS),
                "hint": "Send {\"action\": \"captions\", \"captions\": \"on\"} or \"off\"."}
    payload = _action_transport("captions", {"captions": raw}, extra={"value": 1 if on else 0})
    if payload.get("ok") is True:
        payload["captions"] = on
        payload["hint"] = ("Subtitles on." if on
                           else "Subtitles off. Subtitles burned into the picture cannot be turned off.")
    return payload


def _film_url_problem(url: str) -> str:
    """Why *url* cannot be a film in its own window ('' means it can).

    The window is loaded by Chrome, not by Aura's checked opener, so this is
    the last cheap place to refuse ``file:``/``ftp:`` and Aura's own page —
    the token-bearing URL is a player, not a film.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return "film url is not a valid URL"
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        return "film url must be http(s)"
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError:
        return "film url has an invalid port"
    aura_port = _port()
    if (aura_port and port == int(aura_port)
            and parsed.hostname.lower() in ("127.0.0.1", "localhost", "::1")):
        return "film url must not be Aura's own page (pass the film, not the token URL)"
    return ""


def _action_popout(args: dict) -> dict:
    """Open the film's own OS window (optionally at a given position)."""
    body: dict = {}
    url = args.get("url")
    if isinstance(url, str) and url.strip():
        body["url"] = url.strip()
        problem = _film_url_problem(body["url"])
        if problem:
            return {"ok": False, "error": problem,
                    "hint": "Pass the film's http(s) URL; the window loads it directly."}
    raw = args.get("position")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        body["position"] = max(0.0, float(raw))
    window_status = _get("/api/window")
    if window_status.get("ok") is True and window_status.get("available") is False:
        # No silent substitution: popout means the OS window. Say why it cannot
        # happen and let the caller choose action=popout_inline instead.
        return {
            "ok": False,
            "error": "no_browser",
            "hint": "No Chrome or Chromium was found, so the film cannot open in its "
                    "own window. It stays where it is — use action=popout_inline for "
                    "the floating window inside Hermes.",
        }
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


def _action_popout_inline(args: dict) -> dict:
    """Put the film in the floating watch window inside Hermes (never an OS window)."""
    body: dict = {"cmd": "watch_window"}
    url = args.get("url")
    if isinstance(url, str) and url.strip():
        body["url"] = url.strip()
        problem = _film_url_problem(body["url"])
        if problem:
            return {"ok": False, "error": problem,
                    "hint": "Pass the film's http(s) URL, or omit it to float the current film."}
    raw = args.get("position")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        body["value"] = max(0.0, float(raw))
    try:
        queued = _request("POST", "/api/player/command", body=body, timeout=20.0)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": "Aura's server is not running; call action=status."}
    if not isinstance(queued, dict) or queued.get("ok") is not True:
        return {"ok": False, "error": "not_delivered",
                "hint": "The floating window did not acknowledge; the film is unchanged."}
    return {"ok": True, "surface": "inline", "seq": queued.get("seq"),
            "hint": "The film is in the floating watch window inside Hermes; "
                    "action=popin returns it to the backdrop."}


def _action_popin() -> dict:
    try:
        result = _request("POST", "/api/window/close", body={}, timeout=20.0)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                "hint": "Aura's server is not running; call action=status."}
    if not isinstance(result, dict) or result.get("ok") is not True:
        return {"ok": False, "error": (result or {}).get("error", "window_failed")}
    if not result.get("closed"):
        try:
            queued = _request("POST", "/api/player/command", body={"cmd": "bring_back"})
        except Exception:
            queued = {}
        if queued.get("ok") is True:
            return {"ok": True, "closed": False, "delivery": "queued", "seq": queued.get("seq"),
                    "window": result.get("window", {})}
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
        elif action == "captions":
            payload = _action_captions(args)
        elif action == "popout":
            payload = _action_popout(args)
        elif action == "popout_inline":
            payload = _action_popout_inline(args)
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
        "toggles Aura; intensity sets reaction strength 0..1 (0 = no audio "
        "reaction, 1 = full; a new install starts at 0.25); preset picks a "
        "visualizer "
        "preset (null = server default); mood sets the agent mood (idle, thinking, "
        "tool, approval, error, streaming, done). Transport of the active player "
        "(in-app or its own window): action=pause, resume, next, prev, or seek "
        "with position in seconds. A single-file film has no next/prev; the next "
        "status shows film.player.applied:false and last_command instead of "
        "pretending the skip worked. action=popout moves the film into its own OS "
        "window (another monitor / full screen), action=popout_inline moves it into "
        "the floating window inside Hermes, and action=popin closes either; "
        "optional url and position choose what to open. Use these when the user "
        "says 'pause', 'next episode', 'play the octopus documentary' or 'put it "
        "on my other screen'. action=captions turns the film's subtitles on or off "
        "(captions: on|off) — the choice is remembered and applies to whichever "
        "player owns the picture; subtitles burned into the picture cannot be "
        "turned off. Returns JSON. Never blocks the turn; if the server "
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
                "description": "for intensity: reaction strength 0..1, where 0 draws no audio reaction",
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
            "captions": {
                "type": "string",
                "enum": ["on", "off"],
                "description": "for captions: turn the film's subtitles on or off",
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

# ---------------------------------------------------------------------------
# [listen lane] aura_listen — radio search and the audio channel
#
# Aura can play internet radio and direct audio URLs, independently of the
# video pane, so a film can play muted while music plays. The desktop half
# polls /api/state for `audio_request = {url, label, seq, at, action}`; this
# tool is what puts one there.
# ---------------------------------------------------------------------------

_LISTEN_ACTIONS = ("search_radio", "play", "stop", "volume", "mute_video", "unmute_video")


def _radio_error(message: str) -> dict:
    return {"ok": False, "error": message, "allowed_actions": list(_LISTEN_ACTIONS)}


def _publish_audio(action: str, url: str = "", label: str = "", value: Any = None) -> dict:
    """Hand one audio request to the server (in-process first, HTTP second)."""
    body: dict[str, Any] = {"action": action, "url": url, "label": label}
    if value is not None:
        body["value"] = value
    publish = getattr(_server, "publish_audio_request", None) if _server is not None else None
    if callable(publish):
        return publish(url=url, label=label, action=action, value=value)
    # Core too old (or imported without the new function): the HTTP door still
    # works, and a follower forwards it to the leader as before.
    try:
        _ensure()
        return _request("POST", "/api/audio", body) or {"ok": False, "error": "no_answer"}
    except Exception as exc:  # noqa: BLE001 - a tool must always answer
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


_LAST_SEARCH_ROWS: list[dict] = []


def _station_by_id(sid: str) -> dict | None:
    """A station the user already has: a favorite, a preset, or the last search.

    Radio Browser result ids (``rb-…``) were returned to the model but not kept
    anywhere, so ``play`` with that id failed. The last search is remembered
    here for exactly that hand-off.
    """
    wanted = str(sid or "").strip()
    if not wanted or _radio is None:
        return None
    try:
        for row in _radio.favorites() + _radio.presets():
            if str(row.get("id")) == wanted:
                return row
    except Exception:  # noqa: BLE001 - a broken file must not break the search
        return None
    for row in _LAST_SEARCH_ROWS:
        if str(row.get("id")) == wanted:
            return row
    return None


def _action_search_radio(args: dict) -> dict:
    if _radio is None:
        return _radio_error("radio module unavailable")
    q = args.get("q") or args.get("query") or ""
    tag = args.get("tag") or ""
    if not isinstance(q, str) or not isinstance(tag, str):
        return _radio_error("q and tag must be strings")
    try:
        limit = int(args.get("limit", 8) or 8)
    except (TypeError, ValueError):
        limit = 8
    limit = max(1, min(20, limit))
    try:
        rows = _radio.search(q, tag, limit)
    except _radio.RadioUnavailable:
        rows = []
        for row in _radio.presets():
            name = str(row.get("name", "")).lower()
            tags = [str(t).lower() for t in row.get("tags") or []]
            if q and q.lower() not in name and not any(q.lower() in t for t in tags):
                continue
            if tag and not any(tag.lower() in t for t in tags):
                continue
            rows.append(row)
        note = "Radio Browser is unreachable; these are Aura's curated presets."
    except _radio.RadioError as exc:
        return _radio_error(str(exc))
    else:
        note = ""
    _LAST_SEARCH_ROWS[:] = [dict(row) for row in rows[:20]]
    options = [
        {"n": index + 1, "id": row.get("id", ""), "name": row.get("name", ""),
         "url": row.get("url", ""), "tags": row.get("tags") or [],
         "bitrate": row.get("bitrate") or 0, "country": row.get("country", "")}
        for index, row in enumerate(rows[:limit])
    ]
    payload: dict[str, Any] = {
        "ok": True,
        "count": len(options),
        "stations": options,
        "next": ("Show the user these numbered choices and WAIT for their pick. "
                 "Then call aura_listen with action=play and that station's url "
                 "(or id). Do not play anything until the user chooses."),
    }
    if note:
        payload["note"] = note
    if not options:
        payload["hint"] = "Nothing matched. Try a broader name or a genre tag."
    return payload


def _action_play(args: dict) -> dict:
    if _radio is None:
        return _radio_error("radio module unavailable")
    url = args.get("url") or ""
    station = None
    if not url:
        station = _station_by_id(str(args.get("id") or ""))
        if station:
            url = station.get("url", "")
    if not isinstance(url, str) or not url.strip():
        return _radio_error("play needs a station url (or an id from a search result)")
    label = args.get("label")
    if not isinstance(label, str) or not label.strip():
        label = str((station or {}).get("name") or "")[:200] or url.strip()[:120]
    try:
        target = _radio.prepare_stream(url)
    except _radio.RadioError as exc:
        return _radio_error(str(exc))
    stored = _publish_audio("play", target, label.strip()[:200])
    # [finding 4] "playing" is the desktop's stored seq, not a promise. If the
    # request failed (or the server stored an error) the tool says so next to
    # ok=false instead of claiming music is on.
    playing = bool(stored.get("seq") or stored.get("forwarded")) and not stored.get("error")
    note = "Aura's audio channel starts on the desktop within one poll (~0.25 s)."
    if not playing:
        note = "The request was not stored; the desktop will not start anything."
    return {
        "ok": playing,
        "playing": playing,
        "url": target,
        "label": label.strip()[:200],
        "audio_request": stored,
        "note": note,
    }


def _action_stop() -> dict:
    stored = _publish_audio("stop")
    return {"ok": bool(stored.get("seq") or stored.get("forwarded")), "playing": False,
            "audio_request": stored}


def _action_volume(args: dict) -> dict:
    raw = args.get("volume", args.get("value"))
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return _radio_error("volume must be a number between 0 and 1")
    value = float(raw)
    if not 0.0 <= value <= 1.0:
        return _radio_error("volume must be between 0 and 1")
    stored = _publish_audio("volume", value=value)
    return {"ok": bool(stored.get("seq") or stored.get("forwarded")), "volume": value,
            "audio_request": stored}


def _action_video_muted(muted: bool) -> dict:
    stored = _publish_audio("mute_video" if muted else "unmute_video")
    return {"ok": bool(stored.get("seq") or stored.get("forwarded")), "video_muted": muted,
            "audio_request": stored,
            "note": "The audio channel keeps playing; only the video's sound changes."}


def _tool_aura_listen(args: dict, **kw) -> str:
    """aura_listen — search internet radio, play/stop audio, mute the film."""
    try:
        if not isinstance(args, dict):
            return _dump(_radio_error("arguments must be an object"))
        action = str(args.get("action") or "search_radio").strip().lower()
        if action not in _LISTEN_ACTIONS:
            return _dump(_radio_error(f"unknown action {action!r}"))
        if action == "search_radio":
            payload = _action_search_radio(args)
        elif action == "play":
            payload = _action_play(args)
        elif action == "stop":
            payload = _action_stop()
        elif action == "volume":
            payload = _action_volume(args)
        elif action == "mute_video":
            payload = _action_video_muted(True)
        else:  # unmute_video
            payload = _action_video_muted(False)
        return _dump(payload)
    except Exception as exc:  # noqa: BLE001 — a tool must always answer
        return _dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


SCHEMA_AURA_LISTEN = {
    "name": "aura_listen",
    "description": (
        "Listen to anything in Aura: internet radio and direct audio URLs play on "
        "Aura's own audio channel, independently of the video pane, so music can "
        "play while a film runs muted. HOW TO USE IT: first call "
        "action=search_radio with a name or genre tag, show the user the numbered "
        "choices it returns, and WAIT for them to pick one; then call action=play "
        "with that station's url or id — the last search's rows are remembered, "
        "and id also works for a preset or favorite. Several audio actions in one "
        "turn are delivered in order (play then mute_video both take effect). "
        "action=stop stops the audio; action=volume sets 0..1; "
        "action=mute_video/unmute_video mutes or unmutes the video without "
        "touching the music. Never autoplay a station the user has not chosen. "
        "playing:true on a play means the desktop stored the request, not that "
        "sound is already coming out — confirm before claiming they hear it. "
        "Returns JSON; a radio outage falls back to Aura's curated presets "
        "instead of failing."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(_LISTEN_ACTIONS),
                "description": "What to do (default search_radio).",
            },
            "q": {
                "type": "string",
                "description": "for search_radio: station name or keyword",
            },
            "tag": {
                "type": "string",
                "description": "for search_radio: genre tag, e.g. jazz, ambient, news",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20,
                "description": "for search_radio: how many choices to return (default 8)",
            },
            "url": {
                "type": "string",
                "description": "for play: a public http(s) stream URL (mp3/aac/ogg/opus/flac, or .pls/.m3u)",
            },
            "id": {
                "type": "string",
                "description": "for play: an id from the last search result, preset or favorite",
            },
            "label": {
                "type": "string",
                "description": "for play: what to show the user, e.g. 'NTS Radio 1'",
            },
            "volume": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "for volume: 0..1",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


# ---------------------------------------------------------------------------
# [watch lane] aura_watch — "find me something to watch" -> numbered options ->
# the user picks -> it plays in Aura's video player.
#
# Search never plays anything. The agent shows the numbered options and stops;
# only the user's pick reaches action=play, which queues `{cmd:'load'}` on the
# same player command queue the transport actions use. Playback belongs to
# whichever surface is active (docked pane or the popped-out window); this tool
# only tells it what to load.
# ---------------------------------------------------------------------------

_WATCH_ACTIONS = ("search", "browse", "play", "now", "save", "remove", "list",
                  # [quality] what this film's source can really offer, and the
                  # one command that switches it without losing the place
                  "quality")
_WATCH_SEARCH_LIMIT = 10
_WATCH_BROWSE_LIMIT = 10
#: [quality] The standing rule a film is opened with. ``auto`` plays the file the
#: source names; the other two pick from the item's real derivatives.
_WATCH_QUALITY_PREFERENCES = ("auto", "smallest", "largest")
#: The committed shelf catalogue. Browsing is offline and instant: the file is
#: generated by tools/build_catalog.py, so no network call is made or needed.
_CATALOG_FILE = Path(__file__).resolve().parent / "web" / "catalog.json"
_CATALOG_ROWS: list[dict] | None = None


def _watch_error(message: str) -> dict:
    return {"ok": False, "error": message, "allowed_actions": list(_WATCH_ACTIONS)}


def _catalog_rows() -> list[dict]:
    """The shelf catalogue as clean rows; ``[]`` when the file is unusable."""
    global _CATALOG_ROWS
    if _CATALOG_ROWS is not None:
        return _CATALOG_ROWS
    rows: list[dict] = []
    try:
        data = json.loads(_CATALOG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        data = []
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict):
            continue
        title = entry.get("title")
        url = entry.get("url")
        category = entry.get("category")
        if not (isinstance(title, str) and title.strip()):
            continue
        if not (isinstance(url, str) and url.startswith(("https://", "http://"))):
            continue
        if not (isinstance(category, str) and category.strip()):
            continue
        year = entry.get("year")
        rows.append({
            "title": title.strip(),
            "year": year if isinstance(year, int) and not isinstance(year, bool) else None,
            "category": category.strip(),
            "url": url,
            "note": entry.get("note") if isinstance(entry.get("note"), str) else "",
            "duration_s": entry.get("duration_s") if isinstance(entry.get("duration_s"), int)
            and not isinstance(entry.get("duration_s"), bool) else None,
        })
    _CATALOG_ROWS = rows
    return rows


def _catalog_categories(rows: list[dict]) -> list[dict]:
    """Category names in catalogue order, each with how many titles it holds."""
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    return [{"category": name, "count": count} for name, count in counts.items()]


def _catalog_category_matches(row_category: str, wanted: str) -> bool:
    """Case-insensitive category match that accepts a loose word ("space")."""
    have = row_category.casefold()
    want = wanted.casefold()
    return have == want or want in have or have in want


def _catalog_browse(args: dict) -> dict:
    """Search the committed catalogue by category and/or free text.

    No network and nothing plays: this is how the agent answers "find me a noir
    film" or "some anime" from the same 346 verified titles the shelf shows.
    """
    raw_category = args.get("category")
    raw_query = args.get("query", args.get("q"))
    if raw_category is not None and not isinstance(raw_category, str):
        return _watch_error("category must be a string")
    if raw_query is not None and not isinstance(raw_query, str):
        return _watch_error("query must be a string")
    category = (raw_category or "").strip()
    query = (raw_query or "").strip()
    rows = _catalog_rows()
    if not rows:
        return {
            "ok": False,
            "error": "catalog_unavailable",
            "hint": ("The Aura catalogue is not installed, so there is nothing to browse. "
                     "action=search still searches YouTube."),
            "items": [],
            "text": "",
        }
    if not category and not query:
        categories = _catalog_categories(rows)
        return {
            "ok": True,
            "count": len(rows),
            "categories": categories,
            "items": [],
            "text": "\n".join(f"{c['category']} ({c['count']})" for c in categories),
            "hint": ("Browse the Aura catalogue by passing category= (one of the names above) "
                     "and/or query= (words from a title or its description)."),
        }

    terms = [term for term in query.casefold().split() if term]
    scored = []
    for index, row in enumerate(rows):
        if category and not _catalog_category_matches(row["category"], category):
            continue
        if terms:
            title = row["title"].casefold()
            rest = " ".join((row["note"], row["category"])).casefold()
            score = sum(3 if term in title else 1 for term in terms if term in title or term in rest)
            if score == 0:
                continue
        else:
            score = 0
        scored.append((score, index, row))
    scored.sort(key=lambda item: (-item[0], item[1]))
    matches = scored[:_WATCH_BROWSE_LIMIT]

    items = [{
        "n": position + 1,
        "title": row["title"],
        "year": row["year"],
        "category": row["category"],
        "url": row["url"],
    } for position, (_score, _index, row) in enumerate(matches)]
    if not items:
        return {
            "ok": True,
            "count": 0,
            "items": [],
            "text": "",
            "hint": ("Nothing in the Aura catalogue matches. Try a broader query, or "
                     "action=browse with no arguments to see the categories; "
                     "action=search searches YouTube instead."),
        }
    lines = []
    for item in items:
        bits = [f"{item['n']}. {item['title']}"]
        if item["year"]:
            bits.append(f"({item['year']})")
        bits.append(f"· {item['category']} · {item['url']}")
        lines.append(" ".join(bits))
    return {
        "ok": True,
        "count": len(items),
        "category": category or None,
        "query": query or None,
        "items": items,
        "text": "\n".join(lines),
        "next": ("Show the user these numbered options and WAIT for their pick. Then call "
                 "action=play with that option's url and its title as the label."),
    }


def _format_options(items: list[dict]) -> str:
    """One line per option: ``1. title · channel · length · link``."""
    lines = []
    for item in items:
        title = str(item.get("title") or "(untitled)").strip()
        bits = [title]
        for key in ("channel", "length"):
            value = str(item.get(key) or "").strip()
            if value:
                bits.append(value)
        bits.append(str(item.get("url") or ""))
        lines.append(f"{item.get('n')}. " + " · ".join(bits))
    return "\n".join(lines)


def _action_watch_search(args: dict) -> dict:
    if _search is None:
        return _watch_error("search module unavailable")
    query = args.get("q") or args.get("query") or ""
    if not isinstance(query, str):
        return _watch_error("q must be a string")
    query = query.strip()
    if not query:
        return _watch_error("search needs a query (q), e.g. 'documentary about octopuses'")
    try:
        limit = int(args.get("limit", 6) or 6)
    except (TypeError, ValueError):
        limit = 6
    limit = max(1, min(_WATCH_SEARCH_LIMIT, limit))
    try:
        rows = _search.youtube_search(query, limit)
    except Exception as exc:  # noqa: BLE001 - a tool must always answer
        return _watch_error(f"{type(exc).__name__}: {exc}")
    options = [dict(row, n=index + 1) for index, row in enumerate(rows[:limit])]
    if not options:
        payload = _watch_error("no_results")
        payload.update({
            "query": query,
            "items": [],
            "text": "",
            "hint": ("YouTube returned nothing — it may be unreachable from here, or "
                     "the query is too narrow. Try a broader query, or use your own "
                     "web search and pass a direct link to action=play."),
        })
        return payload
    return {
        "ok": True,
        "query": query,
        "count": len(options),
        "items": options,
        "text": _format_options(options),
        "next": ("Show the user these numbered options (title, channel, length and "
                 "link) and WAIT for their pick. Then call action=play with that "
                 "option's url and title as the label. Do not play anything until "
                 "the user chooses."),
    }


def _action_watch_play(args: dict) -> dict:
    if _search is None:
        return _watch_error("search module unavailable")
    url = args.get("url")
    checked = _search.check_play_url(url)
    if not checked.get("ok"):
        return _watch_error(str(checked.get("error") or "that url cannot be played"))
    target = str(checked.get("url") or "")
    label = args.get("label")
    if not isinstance(label, str) or not label.strip():
        label = target
    label = label.strip()[:200]
    try:
        _ensure()  # Aura starts on first use; a stopped server is started here.
    except Exception:  # noqa: BLE001 - _request below reports honestly
        pass
    payload = _action_transport(
        "load", args, extra={"url": target, "label": label},
        hint=("Aura's server is not running. Aura starts on first use: turn it on "
              "with aura_control action=on, then call action=play again."),
    )
    if payload.get("ok") is not True:
        return payload
    payload.update({
        "playing": True,
        "url": target,
        "label": label,
        "kind": checked.get("kind"),
        "note": ("Queued for the active player; Aura picks it up on its next poll "
                 "(~0.25 s) in the docked pane or the popped-out window, whichever "
                 "is playing."),
    })
    return payload


# ---------------------------------------------------------------------------
# [savelist lane] the owner's own Aura library — save, remove, list
#
# YouTube's own playlists are off-limits; this is the saved list the desktop
# writes into its settings (``videoPlaylists`` / ``videoSources``), the same one
# the Library's Add and Remove buttons edit. The agent never touches settings
# itself: it queues one command on the player queue and the desktop's own
# helpers write it, so the page updates live and there is one owner of truth.
# ---------------------------------------------------------------------------

_WATCH_LIBRARY_LIMIT = 200


def _watch_kind(checked: dict) -> str:
    """Which saved list a playable url belongs in.

    A YouTube ``/playlist`` link is a playlist; a single video or a direct
    media file is a film — exactly the split the desktop's Add button makes
    (``isPlaylistUrl``), so the two cannot drift apart.
    """
    url = str(checked.get("url") or "")
    if "/playlist" in url and "list=" in url:
        return "playlist"
    return "film"


def _watch_library(snapshot: dict) -> list | None:
    """The reported library as clean rows, or ``None`` when not reported."""
    library = snapshot.get("library")
    if not isinstance(library, list):
        return None
    rows = []
    for row in library[:_WATCH_LIBRARY_LIMIT]:
        if isinstance(row, dict) and str(row.get("url") or "").strip():
            rows.append({"label": str(row.get("label") or row["url"]),
                         "url": str(row["url"]),
                         "kind": str(row.get("kind") or "film")})
    return rows


def _watch_row_line(index: int, row: dict) -> str:
    return f"{index}. {row['label']} · {row['kind']} · {row['url']}"


def _watch_match(rows: list, args: dict) -> dict:
    """Resolve the one saved row the owner means.

    ``url`` wins when given; otherwise the label must match exactly (ignoring
    case) or by one unique partial match. Anything ambiguous answers with every
    candidate and changes nothing — a wrong film must never be dropped.
    """
    raw_url = args.get("url")
    if isinstance(raw_url, str) and raw_url.strip():
        target = raw_url.strip()
        if _search is not None:
            checked = _search.check_play_url(target)
            if checked.get("ok"):
                target = str(checked.get("url") or target)
        for row in rows:
            if row["url"] == target:
                return {"ok": True, "row": row}
        return {"ok": False, "error": "not_in_library", "matches": [],
                "text": f"{target} is not in your Aura library."}
    raw_label = args.get("label")
    if not isinstance(raw_label, str) or not raw_label.strip():
        return {"ok": False, "error": "remove needs a url or a label",
                "matches": [],
                "text": "Tell me which one: its link, or the title as it appears "
                        "in your list."}
    wanted = raw_label.strip().lower()
    exact = [row for row in rows if row["label"].strip().lower() == wanted]
    hits = exact or [row for row in rows if wanted in row["label"].lower()]
    if len(hits) == 1:
        return {"ok": True, "row": hits[0]}
    if not hits:
        return {"ok": False, "error": "not_in_library", "matches": [],
                "text": f'Nothing in your Aura library is called "{raw_label.strip()}".'}
    return {"ok": False, "error": "ambiguous", "matches": hits,
            "text": ("That matches more than one saved item, so nothing was "
                     "removed:\n"
                     + "\n".join(_watch_row_line(n + 1, row)
                                 for n, row in enumerate(hits)))}


def _action_watch_save(args: dict) -> dict:
    """Add the given url (or what is playing) to the owner's saved library."""
    snapshot = _player_snapshot()
    player_raw = snapshot.get("player")
    player: dict = player_raw if isinstance(player_raw, dict) else {}
    if _search is None:
        return _watch_error("search module unavailable")
    raw = args.get("url")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        playing = player.get("url")
        if not isinstance(playing, str) or not playing.strip():
            return _watch_error(
                "nothing is playing to save — name the film's link, or play it "
                "first")
        raw = playing
    checked = _search.check_play_url(raw)
    if not checked.get("ok"):
        return _watch_error(str(checked.get("error") or "that url cannot be saved"))
    url = str(checked.get("url") or "")
    label = args.get("label")
    if not isinstance(label, str) or not label.strip():
        # Default to the title the player already knows, so the owner's list
        # reads like their list instead of a wall of urls.
        known = player.get("label") or player.get("title") or ""
        label = str(known).strip()
    else:
        label = label.strip()
    label = label[:200]
    extra: dict = {"url": url}
    if label:
        extra["label"] = label
    try:
        _ensure()  # Aura starts on first use; a stopped server is started here.
    except Exception:  # noqa: BLE001 - _request below reports honestly
        pass
    payload = _action_transport(
        "save", args, extra=extra,
        hint=("Aura's server is not running. Aura starts on first use: turn it on "
              "with aura_control action=on, then call action=save again."),
    )
    if payload.get("ok") is not True:
        return payload
    kind = _watch_kind(checked)
    saved = _watch_library(snapshot)
    already = bool(saved) and any(row["url"] == url for row in saved)
    horizon = "playlists" if kind == "playlist" else "films"
    payload.update({
        "saved": True,
        "url": url,
        "label": label or url,
        "kind": kind,
        "already_in_library": already,
        "text": (f"Saved to your Aura library ({horizon}): "
                 f"{label or url}"),
        "note": ("Queued for the desktop, which writes it into your saved "
                 f"{horizon} on its next poll (~0.25 s) and the Library page "
                 "updates live."),
    })
    return payload


def _action_watch_remove(args: dict) -> dict:
    """Remove one saved item, chosen by url or by its title."""
    snapshot = _player_snapshot()
    if not snapshot:
        return {
            "ok": False,
            "running": False,
            "playing": False,
            "error": "server not running",
            "hint": ("Aura's server is not running. It starts on first use — turn "
                     "it on with aura_control action=on, then ask again."),
        }
    rows = _watch_library(snapshot)
    if rows is None:
        return {
            "ok": False,
            "error": "library_not_reported",
            "matches": [],
            "text": "Your Aura library is not reported yet.",
            "note": ("Your Aura library is not reported yet — the desktop sends it "
                     "with its player report, so Aura's page in Hermes Desktop has "
                     "to poll once (or the app was just started). Try again in a "
                     "moment, or call action=list to check."),
        }
    match = _watch_match(rows, args)
    if not match.get("ok"):
        payload = {"ok": False, "error": match.get("error"),
                   "matches": match.get("matches") or [],
                   "text": match.get("text", "")}
        if payload["matches"]:
            payload["text_lines"] = [_watch_row_line(n + 1, row)
                                     for n, row in enumerate(payload["matches"])]
            payload["note"] = ("Nothing was removed. Ask the owner which one, or "
                               "call action=remove again with that item's url.")
        return payload
    row = match["row"]
    try:
        _ensure()
    except Exception:  # noqa: BLE001
        pass
    extra = {"url": row["url"], "label": row["label"]}
    payload = _action_transport(
        "remove", args, extra=extra,
        hint=("Aura's server is not running. Aura starts on first use: turn it on "
              "with aura_control action=on, then call action=remove again."),
    )
    if payload.get("ok") is not True:
        return payload
    payload.update({
        "removed": True,
        "url": row["url"],
        "label": row["label"],
        "kind": row["kind"],
        "text": f"Removed from your Aura library: {row['label']}",
        "note": ("Queued for the desktop, which writes the change on its next "
                 "poll (~0.25 s)."),
    })
    return payload


def _action_watch_list() -> dict:
    """The owner's saved library, as the desktop last reported it."""
    snapshot = _player_snapshot()
    if not snapshot:
        return {
            "ok": False,
            "running": False,
            "error": "server not running",
            "hint": ("Aura's server is not running. It starts on first use — turn "
                     "it on with aura_control action=on, then ask again."),
        }
    rows = _watch_library(snapshot)
    if rows is None:
        return {
            "ok": True,
            "reported": False,
            "count": 0,
            "items": [],
            "text": "",
            "note": ("Your Aura library is not reported yet — the desktop sends "
                     "it with its player report, so Aura's page in Hermes Desktop "
                     "has to poll once. Nothing is assumed about what you saved."),
        }
    items = [dict(row, n=index + 1) for index, row in enumerate(rows)]
    playlist_count = sum(1 for row in rows if row["kind"] == "playlist")
    film_count = len(rows) - playlist_count
    payload = {
        "ok": True,
        "reported": True,
        "count": len(items),
        "playlists": playlist_count,
        "films": film_count,
        "items": items,
        "text": "\n".join(_watch_row_line(item["n"], item) for item in items),
    }
    if not items:
        payload["text"] = ""
        payload["note"] = "Your Aura library is empty — nothing saved yet."
    return payload


def _action_watch_now() -> dict:
    snapshot = _player_snapshot()
    if not snapshot:
        return {
            "ok": False,
            "running": False,
            "playing": False,
            "error": "server not running",
            "hint": ("Aura's server is not running. It starts on first use — turn it "
                     "on with aura_control action=on, then ask again."),
        }
    player_raw = snapshot.get("player")
    player: dict = player_raw if isinstance(player_raw, dict) else {}
    payload: dict = {
        "ok": True,
        "running": True,
        "playing": bool(player.get("playing")),
        "player": player,
        "window": snapshot.get("window") or {},
    }
    if "command_seq" in snapshot:
        payload["command_seq"] = snapshot["command_seq"]
    if not player:
        payload["hint"] = "The player has not reported yet; nothing is loaded."
    return payload


def _quality_line(index: int, item: dict) -> str:
    bits = [f"{index}. {item.get('label') or 'file'}"]
    if item.get("current"):
        bits.append("(playing)")
    url = str(item.get("url") or "")
    if url:
        bits.append(url)
    return " ".join(bits)


def _action_watch_quality(args: dict) -> dict:
    """What this film's source really offers, and the one switch that keeps time.

    ``list`` (the default) reports the archive.org item's real files, or the
    single honest "Auto (YouTube decides)" for YouTube. ``set`` queues one
    ``quality`` command for the desktop: a choice's url, or the standing
    ``auto``/``smallest``/``largest`` rule. A YouTube film can never be given a
    fake level — the command was measured to be ignored, so nothing is queued.
    """
    snapshot = _player_snapshot()
    if not snapshot:
        return {
            "ok": False,
            "running": False,
            "error": "server not running",
            "hint": ("Aura's server is not running. It starts on first use — turn "
                     "it on with aura_control action=on, then ask again."),
        }
    player_raw = snapshot.get("player")
    player: dict = player_raw if isinstance(player_raw, dict) else {}
    url = str(player.get("url") or "").strip()
    wants_set = any(key in args for key in ("set", "preference", "n", "choice", "url"))
    if not url:
        payload: dict = {
            "ok": False,
            "error": "nothing_playing",
            "preference": _quality_preference(player),
            "hint": ("Nothing is playing, so there are no quality choices. Play a film "
                     "first (action=play), then ask again."),
        }
        if wants_set:
            payload["note"] = "Nothing was queued."
        return payload
    choices = _quality_choices(url)
    if choices is None:
        return {
            "ok": False,
            "error": "quality_unavailable",
            "url": url,
            "hint": ("Aura's server did not answer the quality lookup, so nothing is "
                     "known about this film's files. The film itself is unaffected."),
        }
    items = [dict(choice, n=index + 1)
             for index, choice in enumerate(choices.get("choices") or [])]
    preference = _quality_preference(player)
    mode = str(choices.get("mode") or "unknown")
    if not wants_set:
        payload = {
            "ok": bool(choices.get("ok") is True),
            "mode": mode,
            "url": url,
            "current": choices.get("current") or "",
            "preference": preference,
            "count": len(items),
            "items": items,
            "text": "\n".join(_quality_line(item["n"], item) for item in items),
        }
        if choices.get("ok") is not True:
            payload["error"] = choices.get("error") or "quality_unavailable"
            payload["text"] = ""
        payload["note"] = str(choices.get("note") or "")
        if payload["ok"]:
            payload["next"] = ("To switch, call action=quality with n (the item's number), "
                              "url (that file's url) or preference=smallest|largest|auto.")
        return payload

    # -- set ---------------------------------------------------------------
    requested = args.get("url")
    number = args.get("n", args.get("choice"))
    raw_preference = args.get("preference")
    if raw_preference is not None and raw_preference not in ("", None):
        if raw_preference not in _WATCH_QUALITY_PREFERENCES:
            return _watch_error(
                "preference must be auto, smallest or largest (or use n / url)")
        preference = str(raw_preference)
    target = ""
    if requested is not None:
        if not isinstance(requested, str) or not requested.strip():
            return _watch_error("url must be the url of one of this film's files")
        target = requested.strip()
    elif number is not None:
        try:
            index = int(number)
        except (TypeError, ValueError):
            return _watch_error("n must be the number of one of the options")
        if not 1 <= index <= len(items):
            return _watch_error(f"n must be between 1 and {len(items)}")
        target = str(items[index - 1]["url"])
    elif raw_preference is None:
        return _watch_error(
            "quality needs a choice: n (a number from the list), url (one of the "
            "files) or preference (auto, smallest, largest)")

    if mode == "youtube":
        return {
            "ok": False,
            "error": ("YouTube decides the quality itself: its embed API's "
                      "setPlaybackQuality is deprecated and ignored, so Aura cannot "
                      "switch it. Nothing was changed."),
            "mode": mode,
            "choices": items,
        }
    if mode == "single":
        return {
            "ok": False,
            "error": "a direct file has no other versions to switch to",
            "mode": mode,
            "choices": items,
        }
    if not target and raw_preference in ("smallest", "largest"):
        target = str(choices.get(raw_preference) or "")
    if target and items and not any(item["url"] == target for item in items):
        return _watch_error(
            "that url is not one of this film's files — see action=quality for the list")

    extra: dict = {}
    if target:
        extra["url"] = target
    if raw_preference is not None:
        extra["preference"] = preference
    if not extra:
        return _watch_error("that choice matches nothing this film has")
    try:
        _ensure()
    except Exception:  # noqa: BLE001 - _request below reports honestly
        pass
    payload = _action_transport(
        "quality", args, extra=extra,
        hint=("Aura's server is not running. Aura starts on first use: turn it on "
              "with aura_control action=on, then call action=quality again."),
    )
    if payload.get("ok") is not True:
        return payload
    chosen = next((item for item in items if item["url"] == target), None)
    position = player.get("position")
    label = (chosen or {}).get("label") or "that file"
    text = f"Switching to {label}"
    if isinstance(position, (int, float)) and not isinstance(position, bool) and position > 0:
        text += f" at {int(position)} s — the film keeps its place."
    payload.update({
        "mode": mode,
        "url": target or url,
        "label": label,
        "preference": preference,
        "position": position,
        "text": text,
    })
    payload["note"] = ("Queued for the active player (~0.25 s): it swaps the source and "
                       "seeks to the same second, so the film does not restart. The "
                       "choice is remembered for next time.")
    return payload


def _quality_preference(player: dict) -> str:
    value = player.get("quality")
    return value if value in _WATCH_QUALITY_PREFERENCES else "auto"


def _quality_choices(url: str) -> dict | None:
    """The server's answer for one film, or ``None`` when it did not answer."""
    try:
        payload = _request("GET", "/api/quality?url=" + urllib.parse.quote(url, safe=""))
    except Exception:  # noqa: BLE001 - a tool must always answer
        return None
    return payload if isinstance(payload, dict) and payload else None


def _tool_aura_watch(args: dict, **kw) -> str:
    """aura_watch — search YouTube, play the user's pick, report what is playing."""
    try:
        if not isinstance(args, dict):
            return _dump(_watch_error("arguments must be an object"))
        action = str(args.get("action") or "search").strip().lower()
        if action not in _WATCH_ACTIONS:
            return _dump(_watch_error(f"unknown action {action!r}"))
        if action == "search":
            payload = _action_watch_search(args)
        elif action == "browse":
            payload = _catalog_browse(args)
        elif action == "play":
            payload = _action_watch_play(args)
        elif action == "save":
            payload = _action_watch_save(args)
        elif action == "remove":
            payload = _action_watch_remove(args)
        elif action == "list":
            payload = _action_watch_list()
        elif action == "quality":
            payload = _action_watch_quality(args)
        else:  # now
            payload = _action_watch_now()
        return _dump(payload)
    except Exception as exc:  # noqa: BLE001 — a tool must always answer
        return _dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


SCHEMA_AURA_WATCH = {
    "name": "aura_watch",
    "description": (
        "Find something to watch and make it play in Aura's video player (the "
        "docked theatre pane in Hermes Desktop, or the popped-out Aura window, "
        "whichever is playing). To find something to watch: call action=search, "
        "show the user the numbered options with title, channel, length and link, "
        "then STOP and wait for the user to pick. Only call action=play after the "
        "user chooses (or when they named an exact link/title to play now). For "
        "non-YouTube sources you may use your own web search and pass the direct "
        "link to action=play. action=play accepts YouTube watch/youtu.be/shorts/"
        "embed/playlist links and direct .mp4/.webm/.m3u8/.mov files. action=now "
        "reports what is playing. "
        "THE AURA CATALOGUE (346 verified films, documentaries and ambience "
        "titles, grouped into categories): action=browse searches it offline — "
        "category (optional, e.g. 'Anime' or 'Slow TV') and query (optional, words "
        "from a title or its description, e.g. 'noir', 'octopus', 'space') return "
        "up to 10 matches with title, year, category and url; with neither it "
        "lists the categories. Use it for 'find me a noir film' or 'some anime' "
        "before searching YouTube, show the numbered matches and wait for a pick, "
        "then call action=play with that url and title. "
        "THE USER'S OWN SAVED LIBRARY (Aura's list, not YouTube's): action=save "
        "adds a film to it — 'save this' means the film playing now (url may be "
        "left out), 'add the octopus one to my list' means that option's url plus "
        "its title as the label; a playlist link is saved as a playlist, anything "
        "else as a film, and the same url is never saved twice. action=list "
        "answers 'what's on my list?' with every saved item (label, url, kind). "
        "action=remove takes a url or a title, e.g. 'remove Nosferatu': an exact "
        "or unique case-insensitive match is removed, and if the title matches "
        "more than one saved item it returns the matches and changes NOTHING — "
        "ask the user which one. A title that was never saved changes nothing "
        "either. action=list and action=remove read the library the desktop "
        "reports; if it has not reported one yet they say so instead of guessing. "
        "Returns JSON. Nothing is ever autoplayed, and if Aura's server is not "
        "running it says so plainly. "
        "QUALITY (what the film can really be shown at): action=quality with no "
        "arguments lists the choices for the film playing now — an archive.org "
        "item's real files (each with its resolution and size, e.g. 640×480 · "
        "393 MB · h.264) or, for YouTube, the single honest 'Auto (YouTube "
        "decides)' (its embed API's setPlaybackQuality is deprecated and "
        "ignored, so no real level can be set). To switch, call action=quality "
        "with n (an option's number) or url (one of those files): the player "
        "swaps the source and keeps the exact second. preference=auto|smallest|"
        "largest also remembers a standing rule that is applied to the next "
        "archive.org film. A direct .mp4 has one file and no picker."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(_WATCH_ACTIONS),
                "description": "search to offer choices from YouTube; browse to "
                               "search Aura's own 346-title catalogue by category "
                               "and/or query; play to start the chosen one; now "
                               "to ask what is playing; save/remove to change the "
                               "user's saved Aura library; list to read it; "
                               "quality to list or switch the film's real "
                               "versions (default search).",
            },
            "category": {
                "type": "string",
                "description": "for browse: a catalogue category, e.g. 'Anime', "
                               "'Classic films', 'Slow TV', 'Deep sea & oceans' "
                               "(leave out to search every category)",
            },
            "query": {
                "type": "string",
                "description": "for browse: words from a title or its one-line "
                               "description, e.g. 'noir', 'octopus', 'space'; for "
                               "search it is accepted as an alias of q",
            },
            "q": {
                "type": "string",
                "description": "for search: what the user wants to watch, in their "
                               "words, e.g. 'documentary about octopuses'",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": _WATCH_SEARCH_LIMIT,
                "description": "for search: how many numbered options (default 6)",
            },
            "url": {
                "type": "string",
                "description": "for play/save: the chosen option's url (or a direct "
                               "link the user gave you); for save it may be left "
                               "out to save what is playing now; for remove it "
                               "names the saved item",
            },
            "label": {
                "type": "string",
                "description": "for play/save: the title to show in Aura (save "
                               "defaults to the playing film's title); for remove: "
                               "the saved item's title",
            },
            "n": {
                "type": "integer",
                "minimum": 1,
                "description": "for quality: the number of the option whose "
                               "file should play (from the action=quality list)",
            },
            "preference": {
                "type": "string",
                "enum": list(_WATCH_QUALITY_PREFERENCES),
                "description": "for quality: the standing rule for new "
                               "archive.org films — auto (the source's own "
                               "file), smallest or largest",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


TOOLS = (
    ("aura_control", SCHEMA_AURA_CONTROL, _tool_aura_control),
    ("aura_listen", SCHEMA_AURA_LISTEN, _tool_aura_listen),
    ("aura_watch", SCHEMA_AURA_WATCH, _tool_aura_watch),
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
