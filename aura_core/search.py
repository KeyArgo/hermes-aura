"""YouTube search for Aura — "Hermes, find me something to watch".

No API key: the public results page carries ``ytInitialData`` as JSON, the same
trick ``dashboard/plugin_api.py`` uses for playlist episodes. The search page
has used three shapes over the years, so all three are parsed:

* ``videoRenderer``   — the classic result row (20 per page today)
* ``playlistRenderer`` — a playlist result (legacy full-result rows)
* ``lockupViewModel``  — the newer card, used for playlists today
  (``contentType`` says whether it is a video or a playlist)

Everything here is stdlib and never raises: an unreachable YouTube returns an
empty list, a page without ``ytInitialData`` returns an empty list. Callers
(the dashboard route and the ``aura_watch`` tool) decide what to tell the user.

``youtube_search`` also validates and normalises play URLs (``check_play_url``)
so the tool and the dashboard cannot disagree about what is playable.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("aura.search")

SEARCH_URL = "https://www.youtube.com/results"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36")

SEARCH_TIMEOUT = 10.0
CACHE_TTL = 300.0          # five minutes: a re-ask in the same conversation is free
MAX_CACHE_ENTRIES = 64
DEFAULT_LIMIT = 6
MAX_LIMIT = 12

_VIDEO_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
_PLAYLIST_ID_RE = re.compile(r"[A-Za-z0-9_-]{10,}")

_YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtube-nocookie.com", "www.youtube-nocookie.com",
}
_MEDIA_SUFFIXES = (".mp4", ".webm", ".m3u8", ".mov")

_CACHE: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_LOCK = threading.Lock()


def clear_cache() -> None:
    """Drop every cached search (tests, and a caller that wants fresh results)."""
    with _LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# fetching + ytInitialData
# ---------------------------------------------------------------------------

def _fetch(query: str) -> str:
    url = f"{SEARCH_URL}?search_query={urllib.parse.quote_plus(query)}&hl=en"
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(request, timeout=SEARCH_TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


def _initial_data(html: Any) -> Optional[dict]:
    """The page's ``ytInitialData`` object, or None.

    Decoding from the first ``{`` after the assignment is bracket-safe (unlike
    a greedy regex): titles and JSON strings contain braces all the time.
    """
    if not isinstance(html, str):
        return None
    marker = html.find("ytInitialData")
    if marker < 0:
        return None
    start = html.find("{", marker)
    if start < 0:
        return None
    try:
        data, _end = json.JSONDecoder().raw_decode(html[start:])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------
# text helpers (YouTube mixes simpleText, runs and content in one document)
# ---------------------------------------------------------------------------

def _text(obj: Any) -> str:
    if isinstance(obj, str):
        return obj.strip()
    if not isinstance(obj, dict):
        return ""
    for key in ("simpleText", "content"):
        value = obj.get(key)
        if isinstance(value, str):
            return value.strip()
    runs = obj.get("runs")
    if isinstance(runs, list):
        return "".join(
            str(part.get("text") or "") for part in runs if isinstance(part, dict)
        ).strip()
    return ""


def _first_text(*objs: Any) -> str:
    for obj in objs:
        text = _text(obj)
        if text:
            return text
    return ""


def _lockup_parts(lockup: dict) -> List[str]:
    """Every metadata part on a lockup card, row by row, in page order."""
    metadata = lockup.get("metadata")
    meta = metadata.get("lockupMetadataViewModel") if isinstance(metadata, dict) else None
    if not isinstance(meta, dict):
        return []
    content_meta = meta.get("metadata")
    view = content_meta.get("contentMetadataViewModel") if isinstance(content_meta, dict) else None
    rows = view.get("metadataRows") if isinstance(view, dict) else None
    parts: List[str] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        for part in row.get("metadataParts") or []:
            if isinstance(part, dict):
                text = _text(part.get("text"))
                if text:
                    parts.append(text)
    return parts


def _lockup_badges(lockup: dict) -> List[str]:
    """Badge texts on a lockup thumbnail ("8 videos", "10:03") in depth order."""
    found: List[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            badge = node.get("thumbnailBadgeViewModel")
            if isinstance(badge, dict) and isinstance(badge.get("text"), str):
                found.append(badge["text"].strip())
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(lockup.get("contentImage"))
    return [text for text in found if text]


def _lockup_title(lockup: dict) -> str:
    metadata = lockup.get("metadata")
    meta = metadata.get("lockupMetadataViewModel") if isinstance(metadata, dict) else None
    if isinstance(meta, dict):
        return _text(meta.get("title"))
    return ""


def _looks_like_count(text: str) -> bool:
    lowered = text.lower()
    return ("view" in lowered or "playlist" in lowered
            or lowered in ("video", "videos") or "ago" in lowered)


# ---------------------------------------------------------------------------
# result shapes
# ---------------------------------------------------------------------------

def _video_item(renderer: dict) -> Optional[dict]:
    vid = renderer.get("videoId")
    if not isinstance(vid, str) or not _VIDEO_ID_RE.fullmatch(vid):
        return None
    channel = _first_text(renderer.get("ownerText"), renderer.get("longBylineText"),
                          renderer.get("shortBylineText"))
    views = _first_text(renderer.get("viewCountText"),
                        renderer.get("shortViewCountText"))
    return {
        "kind": "video",
        "id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}",
        "title": _text(renderer.get("title"))[:200],
        "channel": channel[:120],
        "length": _text(renderer.get("lengthText"))[:40],
        "views": views[:60],
    }


def _playlist_item(renderer: dict) -> Optional[dict]:
    pid = renderer.get("playlistId")
    if not isinstance(pid, str) or not _PLAYLIST_ID_RE.fullmatch(pid):
        return None
    return {
        "kind": "playlist",
        "id": pid,
        "url": f"https://www.youtube.com/playlist?list={pid}",
        "title": _text(renderer.get("title"))[:200],
        "channel": _first_text(renderer.get("shortBylineText"),
                               renderer.get("longBylineText"))[:120],
        # A playlist has a video count, not a runtime; the numbered list shows it
        # in the length column so "8 videos" reads naturally.
        "length": _text(renderer.get("videoCount"))[:40],
        "views": _text(renderer.get("viewCountText"))[:60],
    }


def _lockup_item(lockup: dict) -> Optional[dict]:
    cid = lockup.get("contentId")
    if not isinstance(cid, str) or not cid:
        return None
    content_type = str(lockup.get("contentType") or "").upper()
    parts = _lockup_parts(lockup)
    is_playlist = "PLAYLIST" in content_type
    if not content_type:
        # Older lockups omit contentType; "Playlist" in the metadata gives it away.
        is_playlist = any("playlist" in part.lower() for part in parts)
    if is_playlist:
        if not _PLAYLIST_ID_RE.fullmatch(cid):
            return None
        kind, url = "playlist", f"https://www.youtube.com/playlist?list={cid}"
    else:
        if not _VIDEO_ID_RE.fullmatch(cid):
            return None
        kind, url = "video", f"https://www.youtube.com/watch?v={cid}"
    badges = _lockup_badges(lockup)
    channel = next((part for part in parts if not _looks_like_count(part)), "")
    views = next((part for part in parts if "view" in part.lower()), "")
    return {
        "kind": kind,
        "id": cid,
        "url": url,
        "title": _lockup_title(lockup)[:200],
        "channel": channel[:120],
        # For a video the badge is the runtime ("10:03"); for a playlist it is
        # the video count ("8 videos"). Either reads correctly in the list.
        "length": (badges[0] if badges else "")[:40],
        "views": views[:60],
    }


def _walk(node: Any, out: List[dict]) -> None:
    if isinstance(node, dict):
        renderer = node.get("videoRenderer")
        if isinstance(renderer, dict):
            item = _video_item(renderer)
            if item:
                out.append(item)
        playlist = node.get("playlistRenderer")
        if isinstance(playlist, dict):
            item = _playlist_item(playlist)
            if item:
                out.append(item)
        lockup = node.get("lockupViewModel")
        if isinstance(lockup, dict):
            item = _lockup_item(lockup)
            if item:
                out.append(item)
        for value in node.values():
            _walk(value, out)
    elif isinstance(node, list):
        for value in node:
            _walk(value, out)


# ---------------------------------------------------------------------------
# public: search
# ---------------------------------------------------------------------------

def youtube_search(query: str, limit: int = DEFAULT_LIMIT) -> List[Dict[str, Any]]:
    """Search YouTube for ``query``; a list of result dicts, never raises.

    Each result: ``{kind: 'video'|'playlist', id, url, title, channel, length,
    views}``. A five-minute cache keeps a re-ask in the same conversation free.
    An outage, a blocked page or an unparsable page all return ``[]``.
    """
    try:
        if not isinstance(query, str):
            return []
        q = query.strip()
        if not q:
            return []
        try:
            wanted = int(limit)
        except (TypeError, ValueError):
            wanted = DEFAULT_LIMIT
        wanted = max(1, min(MAX_LIMIT, wanted))

        key = q.casefold()
        now = time.time()
        with _LOCK:
            hit = _CACHE.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return [dict(item) for item in hit[1][:wanted]]

        try:
            html = _fetch(q)
        except Exception as exc:  # noqa: BLE001 - an outage is an empty list
            logger.info("aura search: %r failed (%s)", q, type(exc).__name__)
            return []
        data = _initial_data(html)
        if data is None:
            logger.info("aura search: no ytInitialData for %r", q)
            return []

        found: List[dict] = []
        _walk(data, found)
        items: List[dict] = []
        seen: set = set()
        for item in found:
            identity = (item.get("kind"), item.get("id"))
            if identity in seen:
                continue
            seen.add(identity)
            items.append(item)

        with _LOCK:
            if len(_CACHE) >= MAX_CACHE_ENTRIES:
                _CACHE.clear()
            _CACHE[key] = (now, items)
        return [dict(item) for item in items[:wanted]]
    except Exception as exc:  # noqa: BLE001 - a search must always answer
        logger.info("aura search: unexpected failure (%s)", type(exc).__name__)
        return []


# ---------------------------------------------------------------------------
# public: what may be played
# ---------------------------------------------------------------------------

def check_play_url(url: Any) -> dict:
    """Validate one play URL and normalise it.

    Accepts YouTube watch / youtu.be / shorts / embed / live / playlist links
    and direct ``.mp4``/``.webm``/``.m3u8``/``.mov`` files over http(s).
    Returns ``{ok, url, kind}`` or ``{ok: False, error}``.
    """
    if not isinstance(url, str):
        return {"ok": False, "error": "url must be a string"}
    raw = url.strip()
    if not raw:
        return {"ok": False, "error": "play needs a url"}
    try:
        parts = urllib.parse.urlsplit(raw)
    except ValueError:
        return {"ok": False, "error": "that is not a valid url"}
    if parts.scheme.lower() not in ("http", "https"):
        return {"ok": False, "error": "url must start with http:// or https://"}
    host = (parts.hostname or "").lower()
    if not host:
        return {"ok": False, "error": "url has no host"}
    query = urllib.parse.parse_qs(parts.query)
    list_id = (query.get("list") or [""])[0]
    if list_id and not _PLAYLIST_ID_RE.fullmatch(list_id):
        list_id = ""

    def watch(vid: str) -> dict:
        target = f"https://www.youtube.com/watch?v={vid}"
        if list_id:
            target += f"&list={list_id}"
        return {"ok": True, "url": target, "kind": "youtube"}

    if host == "youtu.be":
        vid = parts.path.strip("/").split("/")[0]
        if _VIDEO_ID_RE.fullmatch(vid):
            return watch(vid)
        return {"ok": False, "error": "that youtu.be link has no video id"}

    if host in _YOUTUBE_HOSTS:
        segments = [seg for seg in parts.path.split("/") if seg]
        head = segments[0].lower() if segments else ""
        if head == "watch":
            vid = (query.get("v") or [""])[0]
            if _VIDEO_ID_RE.fullmatch(vid):
                return watch(vid)
            return {"ok": False, "error": "that YouTube link has no video id"}
        if head in ("shorts", "embed", "live", "v") and len(segments) > 1:
            vid = segments[1]
            if _VIDEO_ID_RE.fullmatch(vid):
                return watch(vid)
            return {"ok": False, "error": "that YouTube link has no video id"}
        if head == "playlist":
            if list_id and _PLAYLIST_ID_RE.fullmatch(list_id):
                return {"ok": True,
                        "url": f"https://www.youtube.com/playlist?list={list_id}",
                        "kind": "youtube"}
            return {"ok": False, "error": "that playlist link has no list id"}
        return {"ok": False,
                "error": "that YouTube link is not a video, shorts, embed or playlist link"}

    if parts.path.lower().endswith(_MEDIA_SUFFIXES):
        return {"ok": True, "url": raw, "kind": "direct"}
    return {"ok": False,
            "error": "url must be a YouTube video/playlist link or a direct "
                     ".mp4, .webm, .m3u8 or .mov file"}
