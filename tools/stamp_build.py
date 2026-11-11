#!/usr/bin/env python3
"""Write BUILD_INFO.json: the exact build, not the declared version.

Generated, never committed (.gitignore). Precedence in aura_core/version_stamp.py
is BUILD_INFO.json -> live git -> plugin.yaml, so an installed copy with no .git
still states which commit it came from.

    python3 tools/stamp_build.py            # dev build: 1.0.0-dev.<commit count>
    python3 tools/stamp_build.py --release  # 1.0.0 (tagged release)
    python3 tools/stamp_build.py --rc 1     # 1.0.0-rc.1
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git(*args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def declared_version() -> str:
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    match = re.search(r"^version:\s*[\"']?([^\"'\n]+)", text, re.MULTILINE)
    return (match.group(1) if match else "0.0.0").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true", help="stamp X.Y.Z with no -dev suffix")
    parser.add_argument("--rc", type=int, metavar="N", help="stamp X.Y.Z-rc.N")
    parser.add_argument("--out", default=str(ROOT / "BUILD_INFO.json"))
    args = parser.parse_args()

    release = declared_version().split("-")[0]
    commits = git("rev-list", "--count", "HEAD") or "0"
    if args.release:
        version, channel = release, "release"
    elif args.rc is not None:
        version, channel = f"{release}-rc.{args.rc}", "rc"
    else:
        version, channel = f"{release}-dev.{commits}", "dev"

    dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")

    info = {
        "version": version,
        "release": release,
        "commit": git("rev-parse", "HEAD"),
        "commit_short": git("rev-parse", "--short=8", "HEAD"),
        "commit_date": git("show", "-s", "--format=%cI", "HEAD"),
        "commits": int(commits) if commits.isdigit() else 0,
        "built_at": now,
        "dirty": dirty,
        "channel": channel,
    }
    Path(args.out).write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"{info['version']} · {info['commit_date'][:10]} · {info['commit_short']}"
          + (" · modified" if dirty else ""))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
