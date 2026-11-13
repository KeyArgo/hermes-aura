"""The version chip standard (VERSION-CHIP.md): one text, one behaviour.

The chip renders `version_stamp.chip_line()`, so these tests pin that function
and the /version contract the desktop half reads. The on-screen behaviour (copy
feedback, no number before the backend answers) is covered in the desktop suite.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aura_core import version_stamp  # noqa: E402


def _info(**over):
    base = {
        "version": "1.0.0-dev.342",
        "commit": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        "commit_short": "1a2b3c4d",
        "commit_date": "2026-11-13T09:12:00-07:00",
        "built_at": "2026-11-13T09:12:05-07:00",
        "channel": "dev",
        "dirty": False,
        "source": "git",
    }
    base.update(over)
    return base


def test_chip_text_is_the_standard_shape():
    assert version_stamp.chip_line(_info()) == "v1.0.0-dev.342 · 1a2b3c4d · 2026-11-13"


def test_chip_text_on_a_release_commit():
    info = _info(version="1.0.0", channel="release")
    assert version_stamp.chip_line(info) == "v1.0.0 · 1a2b3c4d · 2026-11-13"


def test_chip_text_on_a_shallow_install():
    info = _info(version="1.0.0-dev", commit="", commit_short="")
    assert version_stamp.chip_line(info) == "v1.0.0-dev · 2026-11-13"


def test_chip_text_with_no_commit_and_no_date():
    assert version_stamp.chip_line(_info(commit="", commit_short="", commit_date="")) == "v1.0.0-dev.342"


def test_chip_text_marks_a_dirty_tree():
    assert version_stamp.chip_line(_info(dirty=True)).endswith(" · modified")


def test_describe_is_the_same_line():
    """One line, one meaning: the /version command prints what the chip shows."""
    assert version_stamp.describe().startswith("v")


def test_the_version_route_contract():
    """The desktop half reads these keys; `line` is what it renders."""
    info = version_stamp.as_dict()
    for key in ("version", "release", "commit", "commit_short", "commit_date",
                "built_at", "channel", "dirty", "source"):
        assert key in info, f"/version lost {key}"
    assert "line" not in info or info["line"].startswith("v")
