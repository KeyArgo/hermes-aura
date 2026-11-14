"""The version line stays at 1.0.0 until the catalog build (owner, 11-13).

Builds before the catalog release are ``1.0.0-dev``; the chip adds the commit and
date. 1.0.0 itself is whatever goes into the catalog. A bump to 1.1.0 (or any
other line) must be the owner's decision, so this fails loudly if one slips in.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_manifest_stays_on_the_1_0_0_line():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    match = re.search(r'^version:\s*"?([^"\s]+)"?\s*$', text, re.M)
    assert match, "plugin.yaml has no version"
    assert match.group(1) in {"1.0.0-dev", "1.0.0"}, (
        f"plugin.yaml version is {match.group(1)!r}; it stays 1.0.0-dev until the catalog "
        "release (owner, 11-13). Change this test only with the owner's OK."
    )
