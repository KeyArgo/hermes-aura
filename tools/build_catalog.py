#!/usr/bin/env python3
"""Build ``web/catalog.json`` — the Aura shelf's catalogue — from the source TSV.

The source file (``.catalog-source.tsv``, not committed: it carries the
verification columns) has one verified row per title:

    category  title  year  url  licence  note  duration_s  channel  check

This script keeps the seven columns the shelf shows, in a fixed category order,
and drops the rest. It is deterministic: same source plus same network answers
means the same file.

Why the HEAD pass: five archive.org ``/download/<id>/<file>.mp4`` files are
multi-gigabyte masters, which are both slow to start and heavy on the archive's
bandwidth. For each one over 2 GB we look for the item's own smaller derivative
(``<name>_512kb.mp4``, then ``<id>.ia.mp4``) and switch to it ONLY when its HEAD
answers ``200`` with a ``video/*`` type AND a smaller Content-Length. Archive.org
answers 200 for some derivative names that do not exist by serving the original
file; the size check rejects those instead of silently keeping the same bytes
behind a new URL.

Usage:
    python3 tools/build_catalog.py                  # rebuild web/catalog.json
    python3 tools/build_catalog.py --offline        # keep every source URL as-is
    python3 tools/build_catalog.py --source other.tsv --out /tmp/catalog.json
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / ".catalog-source.tsv"
DEFAULT_OUT = ROOT / "web" / "catalog.json"
DEFAULT_CACHE = Path.home() / ".cache" / "aura-catalog-heads.json"

#: The shelf's row order. Every one of these must have at least one title.
CATEGORY_ORDER = (
    "Deep sea & oceans",
    "Nature & wildlife",
    "Space & astronomy",
    "Earth from above",
    "Slow TV",
    "Classic films",
    "Classic cartoons",
    "Anime",
    "Open movies",
    "Science & history docs",
    "Ambience",
)

#: "Over 2 GB" as the web reports file sizes: decimal gigabytes.
BIG_FILE_BYTES = 2_000_000_000

FIELDS = ("category", "title", "year", "url", "licence", "note", "duration_s")
TIMEOUT_S = 25.0
USER_AGENT = "aura-shelf-catalog/1"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Stop at the first hop so a HEAD never turns into a body download."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def head(url: str, timeout: float = TIMEOUT_S) -> dict:
    """HEAD *url*, following redirects by hand. Returns status/type/length."""
    seen = 0
    while seen < 6:
        seen += 1
        request = urllib.request.Request(
            url, method="HEAD", headers={"User-Agent": USER_AGENT}
        )
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                return {
                    "status": int(response.status),
                    "content_type": (response.headers.get("Content-Type") or "")
                    .split(";")[0]
                    .strip()
                    .lower(),
                    "content_length": int(response.headers.get("Content-Length") or 0),
                }
        except urllib.error.HTTPError as exc:
            location = exc.headers.get("Location")
            if exc.code in (301, 302, 303, 307, 308) and location:
                url = urllib.parse.urljoin(url, location)
                continue
            return {"status": int(exc.code), "content_type": "", "content_length": 0}
        except Exception:  # noqa: BLE001 - offline is a normal answer here
            return {"status": 0, "content_type": "", "content_length": 0}
    return {"status": 0, "content_type": "", "content_length": 0}


def _derivative_urls(url: str) -> list[str]:
    """The item's smaller derivatives, in preference order.

    ``<name>_512kb.mp4`` (the classic archive.org derivative name) first, then
    the item's own ``<id>.ia.mp4``. Both sit beside the original.
    """
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.unquote(parts.path)
    marker = "/download/"
    if marker not in path:
        return []
    rest = path.split(marker, 1)[1]
    item, _, filename = rest.partition("/")
    if not item or not filename:
        return []
    base = f"https://archive.org/download/{item}/"
    stem = filename[:-4] if filename.lower().endswith(".mp4") else filename
    candidates = [
        base + urllib.parse.quote(f"{stem}_512kb.mp4"),
        base + urllib.parse.quote(f"{item}.ia.mp4"),
    ]
    return [candidate for candidate in candidates if candidate != url]


def resolve_url(url: str, head_fn, cache: dict) -> str:
    """Return the URL the shelf should keep for one source."""
    if "archive.org/download/" not in url:
        return url
    original = cache.get(url) or {}
    if not original:
        original = head_fn(url)
        cache[url] = original
    length = int(original.get("content_length") or 0)
    if original.get("status") != 200 or length <= BIG_FILE_BYTES:
        return url
    for candidate in _derivative_urls(url):
        answer = cache.get(candidate) or {}
        if not answer:
            answer = head_fn(candidate)
            cache[candidate] = answer
        ctype = str(answer.get("content_type") or "")
        size = int(answer.get("content_length") or 0)
        if answer.get("status") == 200 and ctype.startswith("video/") and 0 < size < length:
            return candidate
    return url


def build(source: Path, out: Path, cache_path: Path | None, offline: bool) -> list[dict]:
    rows = list(csv.DictReader(source.open(encoding="utf-8"), delimiter="\t"))
    if not rows:
        raise SystemExit(f"{source} has no rows")

    unknown = sorted({r["category"] for r in rows} - set(CATEGORY_ORDER))
    if unknown:
        raise SystemExit(f"unknown categories in {source}: {unknown}")

    cache: dict = {}
    if cache_path and cache_path.exists() and not offline:
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cache = {}

    items: list[dict] = []
    for row in rows:
        url = (row.get("url") or "").strip()
        if not url:
            continue
        if not offline:
            url = resolve_url(url, head, cache)
        duration = (row.get("duration_s") or "").strip()
        year = (row.get("year") or "").strip()
        items.append({
            "category": row["category"].strip(),
            "title": (row.get("title") or "").strip(),
            "year": int(year) if year.isdigit() else None,
            "url": url,
            "licence": (row.get("licence") or "").strip(),
            "note": (row.get("note") or "").strip(),
            "duration_s": int(duration) if duration.isdigit() else None,
        })

    order = {name: index for index, name in enumerate(CATEGORY_ORDER)}
    items.sort(key=lambda item: order[item["category"]])

    seen: set[str] = set()
    for item in items:
        if item["url"] in seen:
            raise SystemExit(f"duplicate url after resolution: {item['url']}")
        seen.add(item["url"])

    empty = [name for name in CATEGORY_ORDER if not any(i["category"] == name for i in items)]
    if empty:
        raise SystemExit(f"categories with no titles: {empty}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    if cache_path and not offline and cache:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    return items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE,
                        help="HEAD-answer cache (default: ~/.cache/aura-catalog-heads.json)")
    parser.add_argument("--offline", action="store_true",
                        help="skip the archive.org HEAD pass; keep source URLs")
    args = parser.parse_args(argv)
    items = build(args.source, args.out, args.cache, args.offline)
    counts = {name: sum(1 for item in items if item["category"] == name) for name in CATEGORY_ORDER}
    print(f"wrote {args.out} — {len(items)} titles")
    for name in CATEGORY_ORDER:
        print(f"  {counts[name]:3d}  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
