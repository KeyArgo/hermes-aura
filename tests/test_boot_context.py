"""The warm-start thread runs in the profile that registered the plugin.

One Hermes gateway serves several profiles and says which one a call belongs to through
context-local state (hermes_constants' home override). A plain thread does not inherit
that context, so the boot thread fell back to the process's launch home: a copy of Aura
loaded for another profile started its server for, and wrote the lease and token of,
the default profile instead of its own.
"""

from __future__ import annotations

import contextvars
import importlib.util
import pathlib
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE = contextvars.ContextVar("aura_test_profile", default="launch-profile")


def _load_plugin():
    name = "aura_plugin_boot_context"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class _Ctx:
    """The registration surface, with every call accepted and ignored."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def test_boot_thread_runs_in_the_registering_profile(monkeypatch):
    plugin = _load_plugin()
    seen = []
    done = threading.Event()

    def fake_boot():
        seen.append(PROFILE.get())
        done.set()

    monkeypatch.setattr(plugin, "_boot", fake_boot)
    token = PROFILE.set("aurademo")
    try:
        plugin.register(_Ctx())
    finally:
        PROFILE.reset(token)

    assert done.wait(5), "the boot thread never ran"
    assert seen == ["aurademo"], f"the boot thread ran in {seen}, not the registering profile"
