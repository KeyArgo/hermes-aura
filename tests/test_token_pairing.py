"""Control calls must use the token that belongs to the port they talk to.

``_port()`` comes from the live server (leader lease); the token used to come from the file on
disk. On Windows a second process could rewrite that file, so the pair no longer matched and every
transport command answered 401 while the film kept playing.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def plugin():
    """The plugin package itself (its directory name is the repo root)."""
    spec = importlib.util.spec_from_file_location("aura_plugin_root", ROOT / "__init__.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_token_prefers_the_live_server_over_the_file(plugin, monkeypatch, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("stale-from-disk\n", encoding="utf-8")
    monkeypatch.setattr(plugin, "_token_path", lambda: token_file)
    monkeypatch.setattr(plugin, "_server", types.SimpleNamespace(get_token=lambda: "live-token"))

    assert plugin._token() == "live-token"


def test_token_falls_back_to_the_file_when_no_server_is_loaded(plugin, monkeypatch, tmp_path):
    token_file = tmp_path / "token"
    token_file.write_text("from-disk\n", encoding="utf-8")
    monkeypatch.setattr(plugin, "_token_path", lambda: token_file)
    monkeypatch.setattr(plugin, "_server", None)

    assert plugin._token() == "from-disk"


def test_token_is_none_when_neither_source_has_one(plugin, monkeypatch, tmp_path):
    monkeypatch.setattr(plugin, "_token_path", lambda: tmp_path / "missing")
    monkeypatch.setattr(plugin, "_server", types.SimpleNamespace(get_token=lambda: ""))

    assert plugin._token() is None
