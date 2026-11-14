"""The version line stays at 1.0.0 until the catalog build (owner, 11-13).

plugin.yaml names the release target, ``1.0.0``. The chip reads the build:
``1.0.0`` only for the exact catalog pin (or a v1.0.0 tag), ``1.0.0-dev.N`` for every
other build, where N only climbs: ``dev_base`` carries the builds numbered in the
old private repo (the last chip there read 1.0.0-dev.94), so no new build reads
older than one already installed. A move to 1.1.0 is the owner's decision.
"""

import importlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_manifest_stays_on_the_1_0_0_line():
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    match = re.search(r'^version:\s*"?([^"\s]+)"?\s*$', text, re.M)
    assert match, "plugin.yaml has no version"
    assert match.group(1) == "1.0.0", (
        f"plugin.yaml version is {match.group(1)!r}; it stays 1.0.0 until the owner says "
        "otherwise (owner, 11-13). Change this test only with the owner's OK."
    )


def test_dev_numbers_continue_above_the_old_repo():
    base = json.loads((ROOT / ".release-check.json").read_text(encoding="utf-8"))["dev_base"]
    assert isinstance(base, int) and base >= 95, "dev_base must keep N above the old repo's dev.94"


def test_a_dev_checkout_reads_1_0_0_dev_n(monkeypatch):
    stamp = importlib.import_module("aura_core.version_stamp")
    stamp = importlib.reload(stamp)
    shallow = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--is-shallow-repository"],
                             capture_output=True, text=True).stdout.strip()
    monkeypatch.setattr(stamp, "_find_build_info", lambda: {})
    monkeypatch.setattr(stamp, "_catalog_pin", lambda: "")
    version = stamp.as_dict()["version"]
    if shallow == "true":
        assert version == "1.0.0-dev"
    else:
        match = re.fullmatch(r"1\.0\.0-dev\.(\d+)", version)
        assert match, f"a dev build reads {version!r}, not 1.0.0-dev.N"
        assert int(match.group(1)) > 94
