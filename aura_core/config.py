"""Aura configuration: the JSON file under the Hermes home directory.

Layout (all paths derive from ``HERMES_HOME``, default ``~/.hermes``)::

    <HERMES_HOME>/aura/config.json    0600, atomic replace
    <HERMES_HOME>/aura/token          0600, written by the server on start

Everything here is tolerant: a corrupt or missing file yields the defaults, a
wrong-typed field is coerced or ignored, and no function raises on bad input.
Stdlib only; no third-party imports at runtime.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger("aura.config")

CONFIG_VERSION = 1

DEFAULTS = {
    "enabled": False,
    # Keep analysing system audio with nobody watching. Off by default: capture
    # and FFT cost ~4% of a core, which should buy something.
    "listen_background": False,
    # First-run only (owner, 11-13): no extra reaction until the user turns it up.
    "intensity": 0.0,
    "preset": None,
    "reduced_motion": False,
    # Kept for /api/config (§1) even though the task text lists four fields.
    "theme_opt_in": False,
    # Display controls (CONTRACT.md §9). Opacity dims the canvas and its scrim
    # together; behavior is a named profile with concrete render parameters.
    # These are first-run defaults only; a saved config keeps its own values
    # and a corrupt/missing key alone falls back here.
    "opacity": 0.4,
    "behavior": "balanced",
    "mood_reactive": True,
    # Opt-in: the host accent is never repainted unless the user asks for it.
    "accent_pulse": False,
    "auto_preset": True,
    # Motion source for the visualizer: ambient designs, real audio, both, or
    # the agent's own activity (optionally alongside music).
    "motion": "agent_music",
    # What the render gain does while the agent is idle (mood idle/done):
    # stop -> dark, ember -> a low ember glow, always -> unchanged.
    "idle_motion": "always",
}

BEHAVIORS = ("calm", "balanced", "intense")
# `designs` is legacy but still accepted and works; the desktop select no
# longer offers it. The agent values gate the ambient designs on the raw mood
# stream (see CONTRACT.md §9.1).
MOTIONS = ("designs", "both", "music", "agent", "agent_music")
IDLE_MOTIONS = ("stop", "ember", "always")

_lock = threading.RLock()


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

def _hermes_constants_home() -> Path | None:
    """The context-local home Hermes reports, when the agent package is importable.

    The gateway is one process serving several profiles and exposes a
    context-local override while it runs a turn for a profile. That override
    must win over the shared process ``HERMES_HOME``. Anything unexpected
    (missing module, bad value, import-time failure) falls back to the env
    logic below so tests and standalone use keep working.
    """
    try:
        from hermes_constants import get_hermes_home as _get_home
    except ImportError:
        return None
    try:
        return Path(_get_home()).expanduser()
    except Exception:  # noqa: BLE001 - any failure falls back to the env logic
        return None


def hermes_home() -> Path:
    """The Hermes home directory for the *current* context.

    Resolution order: the Hermes context-local override (when importable), then
    ``HERMES_HOME``, then the default. Evaluated at call time and never cached,
    because a gateway turn can switch profiles between calls.
    """
    override = _hermes_constants_home()
    if override is not None:
        return override
    raw = os.environ.get("HERMES_HOME")
    if raw:
        try:
            return Path(raw).expanduser()
        except (TypeError, ValueError):
            pass
    return Path("~/.hermes").expanduser()


def aura_dir() -> Path:
    return hermes_home() / "aura"


def config_path() -> Path:
    return aura_dir() / "config.json"


def token_path() -> Path:
    return aura_dir() / "token"


def lock_path() -> Path:
    """Leader-election lock for the single local server (CONTRACT §7)."""
    return aura_dir() / "server.lock"


def lease_path() -> Path:
    """The leader's ``{pid,port,token,started,capture}`` advertisement."""
    return aura_dir() / "lease.json"


def _ensure_dir() -> Path:
    d = aura_dir()
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


# ---------------------------------------------------------------------------
# validation / coercion
# ---------------------------------------------------------------------------

def _as_bool(value, default):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("1", "true", "yes", "on"):
            return True
        if low in ("0", "false", "no", "off"):
            return False
    return default


def _as_intensity(value, default):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError, OverflowError):
        return default


def _as_preset(value, default):
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    return default


def _as_opacity(value, default):
    """Opacity is 0..1 like intensity; bools are not numbers here."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError, OverflowError):
        return default


def _as_behavior(value, default):
    if isinstance(value, str) and value.strip().lower() in BEHAVIORS:
        return value.strip().lower()
    return default


def _as_motion(value, default):
    if isinstance(value, str) and value.strip().lower() in MOTIONS:
        return value.strip().lower()
    return default


def _as_idle_motion(value, default):
    if isinstance(value, str) and value.strip().lower() in IDLE_MOTIONS:
        return value.strip().lower()
    return default


def normalise(raw) -> dict:
    """Return a fully-populated, type-safe config dict from arbitrary input."""
    cfg = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return cfg
    cfg["enabled"] = _as_bool(raw.get("enabled"), DEFAULTS["enabled"])
    cfg["listen_background"] = _as_bool(raw.get("listen_background"), DEFAULTS["listen_background"])
    cfg["intensity"] = _as_intensity(raw.get("intensity"), DEFAULTS["intensity"])
    cfg["preset"] = _as_preset(raw.get("preset"), DEFAULTS["preset"])
    cfg["reduced_motion"] = _as_bool(raw.get("reduced_motion"), DEFAULTS["reduced_motion"])
    cfg["theme_opt_in"] = _as_bool(raw.get("theme_opt_in"), DEFAULTS["theme_opt_in"])
    cfg["opacity"] = _as_opacity(raw.get("opacity"), DEFAULTS["opacity"])
    cfg["behavior"] = _as_behavior(raw.get("behavior"), DEFAULTS["behavior"])
    cfg["mood_reactive"] = _as_bool(raw.get("mood_reactive"), DEFAULTS["mood_reactive"])
    cfg["accent_pulse"] = _as_bool(raw.get("accent_pulse"), DEFAULTS["accent_pulse"])
    cfg["auto_preset"] = _as_bool(raw.get("auto_preset"), DEFAULTS["auto_preset"])
    cfg["motion"] = _as_motion(raw.get("motion"), DEFAULTS["motion"])
    cfg["idle_motion"] = _as_idle_motion(raw.get("idle_motion"), DEFAULTS["idle_motion"])
    return cfg


# ---------------------------------------------------------------------------
# load / save
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Read the config file. Missing, unreadable or corrupt input -> defaults."""
    with _lock:
        path = config_path()
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return dict(DEFAULTS)
        except OSError as exc:
            logger.info("aura: config unreadable (%s); using defaults", type(exc).__name__)
            return dict(DEFAULTS)
        try:
            raw = json.loads(text)
        except (ValueError, TypeError):
            logger.info("aura: config corrupt; using defaults")
            return dict(DEFAULTS)
        return normalise(raw)


def _atomic_write(path: Path, payload: bytes, mode: int = 0o600) -> None:
    """Write ``payload`` to ``path`` atomically, owner-only, fsync'd."""
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(directory))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def save_config(cfg: dict) -> dict:
    """Validate and persist ``cfg``; returns the normalised dict actually stored."""
    clean = normalise(cfg)
    payload = json.dumps(clean, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    with _lock:
        _ensure_dir()
        _atomic_write(config_path(), payload)
    return clean


def merge_config(patch: dict) -> dict:
    """Apply ``patch`` (already validated by the caller) on top of the stored config."""
    with _lock:
        current = load_config()
        current.update(patch)
        return save_config(current)


def get(key: str, default=None):
    """Single-key read that never raises."""
    try:
        return load_config().get(key, default)
    except Exception:  # noqa: BLE001 - config must never break a turn
        return default


def write_token(token: str) -> None:
    """Persist the server token, owner-only, atomically."""
    with _lock:
        _ensure_dir()
        _atomic_write(token_path(), (token + "\n").encode("utf-8"))


def read_token() -> str:
    try:
        return token_path().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write_lease(payload: dict) -> None:
    """Persist the leader advertisement, owner-only, atomically."""
    with _lock:
        _ensure_dir()
        data = json.dumps(payload, sort_keys=True).encode("utf-8") + b"\n"
        _atomic_write(lease_path(), data)


def read_lease() -> dict | None:
    """Read the leader advertisement; corrupt/missing input -> ``None``."""
    try:
        raw = json.loads(lease_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return raw if isinstance(raw, dict) else None


def capture_override() -> str | None:
    """Optional ``AURA_CAPTURE`` env override (``none`` disables capture).

    Used by tests and by users who want accent-only mode. Unknown values are
    ignored by the probe.
    """
    raw = os.environ.get("AURA_CAPTURE", "").strip().lower()
    return raw or None
