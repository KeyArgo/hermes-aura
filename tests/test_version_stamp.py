"""The build states its own identity, and the page shows the same stamp.

A version typed into `aura.js` or `server.py` drifts from the checkout that is
actually running — `VERSION` had already fallen behind `plugin.yaml` once.
"""

from __future__ import annotations

from pathlib import Path

from aura_core import version_stamp

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def test_the_stamp_is_vendored_in_the_package():
    assert (ROOT / "aura_core" / "version_stamp.py").is_file()


def test_the_stamp_never_invents_a_commit():
    info = version_stamp.as_dict()
    assert info["version"]
    assert info["source"] in {"build_info", "git", "manifest"}
    if info["source"] == "manifest":
        assert info["commit"] == ""


def test_the_declared_version_is_the_one_the_stamp_reports():
    info = version_stamp.as_dict()
    if info["source"] == "build_info":
        return  # an installed copy answers from its own stamp
    declared = [line for line in (ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines()
                if line.startswith("version:")][0].split(":", 1)[1].strip().strip('"')
    assert info["version"] == declared
    assert declared == "1.0.0"


def test_describe_is_one_readable_line():
    parts = version_stamp.describe().split(" · ")
    assert parts[0]
    if len(parts) > 1:
        assert len(parts[1]) == 8, "the commit is always shown short"


def test_build_info_is_not_committed():
    assert "BUILD_INFO.json" in (ROOT / ".gitignore").read_text(encoding="utf-8")


def test_the_server_version_comes_from_the_stamp():
    from aura_core import server

    assert server.VERSION == version_stamp.version()


def test_the_version_route_reports_the_same_version_as_the_stamp():
    from aura_core import server

    payload = dict(server._BUILD)
    assert payload["version"] == version_stamp.version()
    assert {"commit", "commit_short", "commit_date", "built_at", "dirty", "channel"} <= set(payload)
    source = (ROOT / "aura_core" / "server.py").read_text(encoding="utf-8")
    assert 'path == "/api/version"' in source


def test_the_page_has_the_chip_and_reads_it_from_the_route():
    index = (WEB / "index.html").read_text(encoding="utf-8")
    assert 'id="app-version"' in index
    script = (WEB / "aura.js").read_text(encoding="utf-8")
    assert "'/api/version'" in script
    assert "dataset.copied = copied ? '1' : 'failed'" in script
    for text in (index, script):
        assert "1.0.0" not in text, "the page must not carry a version literal"
