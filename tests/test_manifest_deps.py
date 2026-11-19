"""The manifest's platform markers must agree with what the code imports.

macOS capture goes through ``sounddevice`` (aura_core/capture/sd_common.py
builds an ``sd.InputStream``), and sounddevice imports numpy for that class.
Hermes core does not ship numpy — it is an optional extra — so a macOS install
that declared only sounddevice met ``ImportError: numpy`` the moment capture
started, while Linux (soundcard) and Windows (soundcard + numpy) were fine.

The rule this file enforces is the general one, not the macOS line: every
platform that asks for a capture backend must ask for numpy behind the same
marker.
"""

from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]

_MARKER = re.compile(r";\s*(?P<marker>.+)$")


def _requirements() -> list[str]:
    """The ``python_dependencies`` entries, quotes stripped (no YAML needed)."""
    lines = (ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith("python_dependencies:")), None)
    assert start is not None, "plugin.yaml declares no python_dependencies at all"
    entries = []
    for line in lines[start + 1:]:
        if line.strip() and not line[:1].isspace():
            break   # the next top-level key
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith("-"):
            continue
        entry = stripped[1:].strip()
        if entry[:1] in ("'", '"') and entry[-1:] == entry[:1]:
            entry = entry[1:-1].strip()
        entries.append(entry)
    assert entries, "python_dependencies is empty"
    return entries


def _markers_for(requirements: list[str], package: str) -> set[str]:
    """The environment markers behind every entry for ``package``."""
    found = set()
    for requirement in requirements:
        if not requirement.lower().startswith(package):
            continue
        marker = _MARKER.search(requirement)
        assert marker, f"{package} is declared unconditionally: {requirement!r}"
        found.add(marker.group("marker").strip())
    return found


def test_every_capture_backend_platform_also_gets_numpy():
    requirements = _requirements()
    sounddevice = _markers_for(requirements, "sounddevice")
    numpy = _markers_for(requirements, "numpy")
    assert sounddevice, "no PortAudio/sounddevice capture backend is declared"
    missing = sounddevice - numpy
    assert not missing, (
        "sounddevice is declared for "
        f"{sorted(missing)} but numpy is not: sd.InputStream raises ImportError "
        "there because Hermes core does not ship numpy"
    )


def test_numpy_pin_is_bounded_where_it_is_declared():
    for requirement in _requirements():
        if not requirement.lower().startswith("numpy"):
            continue
        assert ">=1.24" in requirement and "<3" in requirement, (
            f"the numpy pin is missing or unbounded: {requirement!r}"
        )
