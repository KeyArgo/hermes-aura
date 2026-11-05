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
    "intensity": 0.5,
    "preset": None,
    "reduced_motion": False,
    # Kept for /api/config (§1) even though the task text lists four fields.
    "theme_opt_in": False,
}

_lock = threading.RLock()


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

def hermes_home() -> Path:
    """The Hermes home directory, honouring ``HERMES_HOME`` at call time."""
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


def normalise(raw) -> dict:
    """Return a fully-populated, type-safe config dict from arbitrary input."""
    cfg = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return cfg
    cfg["enabled"] = _as_bool(raw.get("enabled"), DEFAULTS["enabled"])
    cfg["intensity"] = _as_intensity(raw.get("intensity"), DEFAULTS["intensity"])
    cfg["preset"] = _as_preset(raw.get("preset"), DEFAULTS["preset"])
    cfg["reduced_motion"] = _as_bool(raw.get("reduced_motion"), DEFAULTS["reduced_motion"])
    cfg["theme_opt_in"] = _as_bool(raw.get("theme_opt_in"), DEFAULTS["theme_opt_in"])
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


def capture_override() -> str | None:
    """Optional ``AURA_CAPTURE`` env override (``none`` disables capture).

    Used by tests and by users who want accent-only mode. Unknown values are
    ignored by the probe.
    """
    raw = os.environ.get("AURA_CAPTURE", "").strip().lower()
    return raw or None
