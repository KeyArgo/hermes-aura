"""Review — the two "Recommended" items.

1. macOS capture goes through PortAudio (``sounddevice``) and nothing declared
   it, so a macOS install got an empty dependency list and a silent "capture
   unavailable". The manifest now declares it, conditional on darwin.
2. ``_token_path()`` read ``os.environ["HERMES_HOME"]`` directly, which is the
   home the process booted with — not the profile the call is running in. It now
   resolves through ``aura_core.config.hermes_home()``, which follows the
   context-local override.

Both assertions fail on the reviewed commit (90e8b80).
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_plugin():
    name = "aura_plugin_review"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_manifest_declares_sounddevice_for_macos():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    assert "sounddevice" in text, "macOS capture has no declared dependency"
    assert 'sys_platform == "darwin"' in text, "the macOS dependency is not conditional"
    line = next(l for l in text.splitlines() if "sounddevice" in l and l.strip().startswith("-"))
    assert ">=0.4" in line and "<0.6" in line, "the macOS pin is missing or unbounded"


def test_token_path_follows_the_active_hermes_home(tmp_path, monkeypatch):
    from aura_core import config

    plugin = _load_plugin()
    # The context-local override wins over whatever the environment says: this is
    # the whole point of going through hermes_home().
    monkeypatch.setenv("HERMES_HOME", "/nonexistent/boot/home")
    monkeypatch.setattr(config, "hermes_home", lambda: tmp_path, raising=True)
    assert plugin._token_path() == tmp_path / "aura" / "token"


def test_token_path_still_works_without_the_core(tmp_path, monkeypatch):
    """The helper is a convenience, not a dependency: no aura_core, no crash."""
    plugin = _load_plugin()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(plugin, "_TOKEN_FILE", ("aura", "token"))
    # Simulate "core not importable" by breaking the import the helper does.
    original_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def blocked(name, *args, **kwargs):
        if name.endswith("aura_core") or name.endswith("aura_core.config"):
            raise ImportError("no core")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", blocked)
    assert plugin._token_path() == tmp_path / "aura" / "token"
