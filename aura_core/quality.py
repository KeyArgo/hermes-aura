"""Quality choices for the film Aura is playing.

Three kinds of source, three different answers:

* **archive.org** items carry real derivatives and an original, each with its
  own size and resolution, read from ``https://archive.org/metadata/<id>``.
  Those are the choices.
* **YouTube** publishes the level it picked but ignores ``setPlaybackQuality``,
  so its one honest choice is "Auto (YouTube decides)". No ``vq`` parameter is
  used: it is a hack that can break playback.
* **a direct file** is one file, so the UI offers no picker.

Only archive.org is ever contacted, and only for an item id taken out of a
``/download/<id>/...`` or ``/details/<id>`` URL: the URL comes from a model or a
user, so it is validated here rather than trusted. The lookup has a short
timeout, a small read cap and a per-item cache, so a picker cannot stall the
player or hammer the archive.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.request
from typing import Any
from urllib.parse import quote, urlsplit

#: A quality lookup must never be the reason a film stalls. The desktop's own
#: request budget is 4 s, so this stays well inside it.
METADATA_TIMEOUT = 4.0
#: An item's file list is a few KB; a runaway answer is not read any further.
METADATA_MAX_BYTES = 512 * 1024
#: One archive.org item's files do not change minute to minute.
CACHE_TTL_S = 600.0
CACHE_MAX_ITEMS = 32
#: What a browser can actually play. ``.avi`` (Cinepack), ``.gif``, posters and
#: the archive's own metadata files are deliberately NOT choices: offering a
#: file the player cannot play is worse than offering fewer choices.
PLAYABLE_SUFFIXES = (".mp4", ".webm", ".ogv", ".m4v")
AUTO_YOUTUBE = "Auto (YouTube decides)"
AUTO_FILE = "The film's own file"
#: How much of one item the smallest/largest rule may consider.
MAX_CHOICES = 12
UA = "Aura/1.0 (+https://github.com/inovinlabs/aura)"
PREFERENCES = ("auto", "smallest", "largest")

_ARCHIVE_HOSTS = {"archive.org", "www.archive.org"}
_ITEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
_YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com",
    "www.youtube-nocookie.com", "youtu.be",
}

_CACHE: dict[str, tuple[float, dict | None]] = {}
_LOCK = threading.Lock()


def clear_cache() -> None:
    """Drop every cached metadata answer (tests, and a caller wanting fresh)."""
    with _LOCK:
        _CACHE.clear()


# URLs


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def archive_download(url: str) -> tuple[str, str] | None:
    """``(item id, file name)`` for an archive.org film URL, else ``None``.

    ``/download/<id>/<file>`` is the film the catalogue uses; ``/details/<id>``
    names the item and no file. Any other host — including a lookalike like
    ``archive.org.example.com`` — is not archive.org and is refused.
    """
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        return None
    if _host(url) not in _ARCHIVE_HOSTS:
        return None
    try:
        parts = urlsplit(url).path.split("/")
    except ValueError:
        return None
    parts = [part for part in parts if part]
    if len(parts) < 2 or parts[0] not in ("download", "details"):
        return None
    item = parts[1]
    if not _ITEM_RE.match(item):
        return None
    file_name = "/".join(parts[2:]) if parts[0] == "download" else ""
    return item, file_name


def is_youtube(url: str) -> bool:
    return _host(url) in _YOUTUBE_HOSTS


def is_media_file(url: str) -> bool:
    try:
        path = urlsplit(url).path.lower()
    except ValueError:
        return False
    return path.endswith(PLAYABLE_SUFFIXES) or path.endswith(".ogg")


def _download_url(item: str, file_name: str) -> str:
    return f"https://archive.org/download/{quote(item)}/{quote(file_name)}"


# metadata -> choices


def _number(value: Any) -> int | None:
    """A non-negative integer from archive.org's stringly-typed metadata."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = int(value)
    elif isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
    else:
        return None
    return number if number > 0 else None


def _size_label(size_bytes: int | None) -> str:
    if not size_bytes:
        return ""
    if size_bytes >= 1024 * 1024:
        return f"{round(size_bytes / (1024 * 1024))} MB"
    if size_bytes >= 1024:
        return f"{round(size_bytes / 1024)} KB"
    return f"{size_bytes} B"


def _choice_label(choice: dict, file_name: str) -> str:
    bits = []
    width, height = choice.get("width"), choice.get("height")
    if width and height:
        bits.append(f"{width}×{height}")
    elif height:
        bits.append(f"{height}p")
    size = _size_label(choice.get("size_bytes"))
    if size:
        bits.append(size)
    bits.append(choice.get("format") or file_name.rsplit(".", 1)[-1].upper() or "file")
    return " · ".join(bits)


def choices_from_metadata(metadata: Any, item_id: str, current_url: str = "") -> dict:
    """Turn one item's ``/metadata/<id>`` answer into the choices Aura offers.

    Playable files only, largest first, each with the size and resolution the
    metadata really gives. An answer with no usable file is ``ok: False`` —
    never a made-up list.
    """
    files = metadata.get("files") if isinstance(metadata, dict) else None
    if not isinstance(files, list):
        return {
            "ok": False,
            "mode": "archive",
            "item": item_id,
            "error": "metadata_unavailable",
            "choices": [],
            "hint": ("archive.org did not return a file list for this item, so Aura "
                     "cannot say which versions exist."),
        }
    choices: list[dict] = []
    seen: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        if not name.lower().endswith(PLAYABLE_SUFFIXES) or name in seen:
            continue
        seen.add(name)
        choice = {
            "url": _download_url(item_id, name),
            "file": name,
            "source": entry.get("source") if isinstance(entry.get("source"), str) else "",
            "format": entry.get("format") if isinstance(entry.get("format"), str) else "",
            "width": _number(entry.get("width")),
            "height": _number(entry.get("height")),
            "size_bytes": _number(entry.get("size")),
            "current": False,
        }
        choice["label"] = _choice_label(choice, name)
        choices.append(choice)
    if not choices:
        return {
            "ok": False,
            "mode": "archive",
            "item": item_id,
            "error": "metadata_unavailable",
            "choices": [],
            "hint": ("This archive.org item has no file Chromium can play, so there "
                     "is nothing to choose between."),
        }
    choices.sort(key=lambda c: (c["height"] or 0, c["size_bytes"] or 0), reverse=True)
    choices = choices[:MAX_CHOICES]
    current = ""
    if current_url:
        wanted = current_url.strip()
        for choice in choices:
            if choice["url"] == wanted or choice["file"] == wanted:
                choice["current"] = True
                current = choice["url"]
        if not current:
            current = wanted
    return {
        "ok": True,
        "mode": "archive",
        "item": item_id,
        "current": current,
        "choices": choices,
        "smallest": choices[-1]["url"],
        "largest": choices[0]["url"],
        "note": (f"{len(choices)} file{'s' if len(choices) != 1 else ''} on archive.org. "
                 "Switching keeps the place in the film."),
    }


# fetching (cached, short timeout, small read)


def _fetch_metadata(item_id: str) -> dict | None:
    """``/metadata/<id>`` as JSON, or ``None``. Never raises; never logged."""
    url = f"https://archive.org/metadata/{quote(item_id)}"
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=METADATA_TIMEOUT) as response:
            raw = response.read(METADATA_MAX_BYTES + 1)
    except Exception:  # noqa: BLE001 - a picker must not raise into the page
        return None
    if len(raw) > METADATA_MAX_BYTES:
        return None
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (UnicodeDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def metadata_for(item_id: str) -> dict | None:
    """The cached metadata answer for one item (fresh on first use)."""
    now = time.time()
    with _LOCK:
        hit = _CACHE.get(item_id)
        if hit and hit[0] > now:
            return hit[1]
    payload = _fetch_metadata(item_id)
    with _LOCK:
        _CACHE[item_id] = (now + CACHE_TTL_S, payload)
        if len(_CACHE) > CACHE_MAX_ITEMS:
            oldest = sorted(_CACHE.items(), key=lambda kv: kv[1][0])[:len(_CACHE) - CACHE_MAX_ITEMS]
            for key, _value in oldest:
                _CACHE.pop(key, None)
    return payload


# the one entry point


def choices_for(url: Any) -> dict:
    """What quality choices this film honestly has.

    Always a dict, never an exception: the page, the desktop and the tool all
    read this shape.
    """
    raw = url.strip() if isinstance(url, str) else ""
    if not raw or len(raw) > 2048 or not raw.lower().startswith(("http://", "https://")):
        return {
            "ok": False,
            "mode": "unknown",
            "error": "not_a_film",
            "choices": [],
            "hint": "Send the film's http(s) URL.",
        }
    if is_youtube(raw):
        # The embed publishes its levels but ignores the command to change them
        # (see this module's docstring).
        return {
            "ok": True,
            "mode": "youtube",
            "current": "",
            "choices": [{"url": "", "label": AUTO_YOUTUBE, "auto": True, "current": True}],
            "smallest": "",
            "largest": "",
            "note": ("YouTube chooses the quality itself. The embed API's "
                     "setPlaybackQuality is deprecated and ignored, so Aura offers no "
                     "fake levels here."),
        }
    archive = archive_download(raw)
    if archive:
        item_id, file_name = archive
        metadata = metadata_for(item_id)
        if metadata is None:
            return {
                "ok": False,
                "mode": "archive",
                "item": item_id,
                "error": "metadata_unavailable",
                "choices": [],
                "hint": ("archive.org did not answer in time, so Aura cannot list this "
                         "item's files. The film itself plays on the URL it already has."),
            }
        return choices_from_metadata(metadata, item_id, current_url=raw)
    if is_media_file(raw):
        return {
            "ok": True,
            "mode": "single",
            "current": raw,
            "choices": [{"url": raw, "label": AUTO_FILE, "current": True}],
            "smallest": "",
            "largest": "",
            "note": "A direct file is one file, so there is nothing to pick.",
        }
    return {
        "ok": False,
        "mode": "unknown",
        "error": "not_a_film",
        "choices": [],
        "hint": ("This URL is not a film file, a YouTube link or an archive.org item, "
                 "so there is no quality to choose."),
    }


def choice_for_preference(payload: Any, preference: str) -> str:
    """The URL the ``smallest``/``largest`` rule names, or ``''`` for no switch."""
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return ""
    if preference not in ("smallest", "largest"):
        return ""
    url = payload.get(preference)
    return url if isinstance(url, str) else ""
