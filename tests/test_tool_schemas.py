"""Tool schemas must pass strict function-calling validators.

Gemini function declarations and several OpenAI-compatible / local validators
reject JSON Schema constructs that draft-07 allows: a list-valued ``type``,
``anyOf`` / ``oneOf``, and a property with no ``type``. Every schema registered
through ``TOOLS`` is walked here.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load_plugin():
    name = "aura_plugin_schemas"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _schema_problems(schema: dict) -> list[str]:
    """Return validator-breaking issues in one tool schema."""
    problems: list[str] = []

    def walk(node, path: str) -> None:
        if isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, f"{path}[{index}]")
            return
        if not isinstance(node, dict):
            return
        for key in ("anyOf", "oneOf"):
            if key in node:
                problems.append(f"{path} has {key}")
        props = node.get("properties")
        if isinstance(props, dict):
            for name, prop in props.items():
                loc = f"{path}.properties.{name}"
                if not isinstance(prop, dict):
                    problems.append(f"{loc} is not an object")
                    continue
                declared = prop.get("type", None)
                if "type" not in prop:
                    problems.append(f"{loc} missing type")
                elif isinstance(declared, list):
                    problems.append(f"{loc} type is a list: {declared!r}")
                elif not isinstance(declared, str) or not declared:
                    problems.append(f"{loc} type is not a string: {declared!r}")
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                for name, prop in value.items():
                    walk(prop, f"{path}.properties.{name}")
            else:
                walk(value, f"{path}.{key}")

    walk(schema, str(schema.get("name") or "schema"))
    return problems


def test_registered_tool_schemas_are_strict_validator_safe():
    plugin = _load_plugin()
    assert plugin.TOOLS, "no tools registered"
    failures: list[str] = []
    for name, schema, _handler in plugin.TOOLS:
        assert schema["name"] == name
        failures.extend(_schema_problems(schema))
    assert failures == [], "schema constructs strict validators reject:\n" + "\n".join(failures)


def test_preset_empty_string_resets(monkeypatch):
    plugin = _load_plugin()
    calls: list[dict] = []

    def _request(method, path, body=None, timeout=2.0):
        calls.append({"method": method, "path": path, "body": body})
        return {"ok": True, "applied": body or {}}

    monkeypatch.setattr(plugin, "_request", _request)
    monkeypatch.setattr(plugin, "_publish_config", lambda: None)

    for args in (
        {"action": "preset", "preset": ""},
        {"action": "preset", "preset": None},
        {"action": "preset"},
    ):
        payload = json.loads(plugin._tool_aura_control(args))
        assert payload["ok"] is True, payload
        assert payload["preset"] is None

    assert [call["body"] for call in calls] == [{"preset": None}] * 3
