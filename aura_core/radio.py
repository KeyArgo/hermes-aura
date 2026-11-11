"""Internet radio for Aura: curated presets, Radio Browser search, favorites
and stream-URL safety (SSRF guard + .pls/.m3u resolution).

Adapted from REVamp's ``revamp_core/radio.py`` (same author, MIT licence —
see THIRD_PARTY_NOTICES.md). Only the parts Aura needs are kept: presets,
search, a quality-filtered "popular" list, favorites and the URL safety
layer.  REVamp's endless-scroll browsing, category browsing and ICY
now-playing are deliberately not copied. Aura's page plays through
``/api/radio/stream`` so the browser never resolves a station hostname or
follows a redirect that the server did not validate.

All network calls are stdlib ``urllib`` with hard timeouts; failures map to
``RadioUnavailable``/``RadioError`` so a route can answer 502 JSON.
"""

from __future__ import annotations

import errno
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from . import config

UA = "Aura/1.0 (Hermes Aura plugin)"
RADIO_BROWSER_SERVERS = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://all.api.radio-browser.info",
]
# Comma-separated override so a test (or a user behind a blocked mirror) can
# point at another set of mirrors without monkeypatching.
_ovr = os.environ.get("AURA_RADIO_BROWSER_SERVERS", "").strip()
if _ovr:
    RADIO_BROWSER_SERVERS = [s.strip().rstrip("/") for s in _ovr.split(",") if s.strip()]
RADIO_BROWSER_SERVERS = list(dict.fromkeys(RADIO_BROWSER_SERVERS))

SEARCH_TIMEOUT = 8.0
# All mirrors together get this long, so a dead network still answers (with
# presets) inside the dashboard proxy's 10 s timeout.
RB_TOTAL_BUDGET = 7.0
RB_DOWN_COOLDOWN = 5.0
CONNECT_TIMEOUT = 3.5
RB_RETRY_PAUSE = 0.25
RB_ROUNDS = 2
RB_ATTEMPT_CAP = 4.0
PLAYLIST_TIMEOUT = 6.0

SEARCH_CACHE_TTL = 3600.0
POPULAR_TTL = 900.0
MAX_CACHE_ENTRIES = 200

POPULAR_LIMIT = 24
POPULAR_FETCH = 100        # raw stations examined per pool build
POPULAR_MIN_BITRATE = 64   # only when the bitrate is known at all
POPULAR_VOTES_PER_CLICK = 30
POPULAR_MAX_PER_COUNTRY = 5

_rb_down_until = 0.0
_LOCK = threading.RLock()
_SEARCH_CACHE: Dict[str, tuple[float, Any]] = {}
_POPULAR: Optional[tuple[float, List[Dict[str, Any]]]] = None


class RadioError(Exception):
    """A radio request that cannot be answered."""


class RadioUnavailable(RadioError):
    """Radio Browser was unreachable; callers should fall back to presets."""


# ---------------------------------------------------------------------------
# curated presets
# ---------------------------------------------------------------------------

PRESETS: List[Dict[str, Any]] = [
    {"id": "somafm-groovesalad", "name": "SomaFM Groove Salad",
     "url": "https://ice1.somafm.com/groovesalad-128-mp3", "homepage": "https://somafm.com/groovesalad/",
     "tags": ["ambient", "chill", "downtempo"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/groovesalad400.jpg", "country": "USA", "source": "preset"},
    {"id": "somafm-dronezone", "name": "SomaFM Drone Zone",
     "url": "https://ice1.somafm.com/dronezone-128-mp3", "homepage": "https://somafm.com/dronezone/",
     "tags": ["ambient", "space", "drone"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/dronezone400.jpg", "country": "USA", "source": "preset"},
    {"id": "somafm-defcon", "name": "SomaFM DEF CON Radio",
     "url": "https://ice1.somafm.com/defcon-128-mp3", "homepage": "https://somafm.com/defcon/",
     "tags": ["electronic", "ambient"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/defcon400.jpg", "country": "USA", "source": "preset"},
    {"id": "somafm-secretagent", "name": "SomaFM Secret Agent",
     "url": "https://ice1.somafm.com/secretagent-128-mp3", "homepage": "https://somafm.com/secretagent/",
     "tags": ["lounge", "spy", "easy"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/secretagent400.jpg", "country": "USA", "source": "preset"},
    {"id": "nightride", "name": "Nightride FM",
     "url": "https://stream.nightride.fm/nightride.mp3", "homepage": "https://nightride.fm",
     "tags": ["synthwave", "retrowave"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "chillsynth", "name": "Chillsynth FM",
     "url": "https://stream.nightride.fm/chillsynth.mp3", "homepage": "https://nightride.fm/chillsynth",
     "tags": ["chillsynth", "synthwave"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "radioparadise", "name": "Radio Paradise Main Mix",
     "url": "https://stream.radioparadise.com/mp3-192", "homepage": "https://radioparadise.com",
     "tags": ["eclectic", "rock"], "codec": "MP3", "bitrate": 192,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "rp-mellow", "name": "Radio Paradise Mellow Mix",
     "url": "https://stream.radioparadise.com/mellow-192", "homepage": "https://radioparadise.com",
     "tags": ["eclectic", "mellow"], "codec": "MP3", "bitrate": 192,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "rp-rock", "name": "Radio Paradise Rock Mix",
     "url": "https://stream.radioparadise.com/rock-192", "homepage": "https://radioparadise.com",
     "tags": ["rock"], "codec": "MP3", "bitrate": 192,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "rp-global", "name": "Radio Paradise Global Mix",
     "url": "https://stream.radioparadise.com/global-192", "homepage": "https://radioparadise.com",
     "tags": ["world", "eclectic"], "codec": "MP3", "bitrate": 192,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "kexp", "name": "KEXP 90.3 Seattle",
     "url": "https://kexp-mp3-128.streamguys1.com/kexp128.mp3", "homepage": "https://www.kexp.org",
     "tags": ["indie", "eclectic"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "fip", "name": "FIP (Radio France)",
     "url": "https://icecast.radiofrance.fr/fip-midfi.mp3", "homepage": "https://www.radiofrance.fr/fip",
     "tags": ["eclectic", "jazz", "world"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "France", "source": "preset"},
    {"id": "nts1", "name": "NTS Radio 1",
     "url": "https://stream-relay-geo.ntslive.net/stream", "homepage": "https://www.nts.live",
     "tags": ["eclectic", "underground"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "UK", "source": "preset"},
    {"id": "nts2", "name": "NTS Radio 2",
     "url": "https://stream-relay-geo.ntslive.net/stream2", "homepage": "https://www.nts.live",
     "tags": ["eclectic", "underground"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "UK", "source": "preset"},
    {"id": "wfmu", "name": "WFMU Freeform",
     "url": "https://stream0.wfmu.org/freeform-128k", "homepage": "https://wfmu.org",
     "tags": ["freeform", "eclectic"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "tsfjazz", "name": "TSF Jazz",
     "url": "https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3", "homepage": "https://www.tsfjazz.com",
     "tags": ["jazz"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "France", "source": "preset"},
    {"id": "wqxr", "name": "WQXR New York",
     "url": "https://stream.wqxr.org/wqxr", "homepage": "https://www.wqxr.org",
     "tags": ["classical"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "wnyc", "name": "WNYC 93.9 FM",
     "url": "https://fm939.wnyc.org/wnycfm", "homepage": "https://www.wnyc.org",
     "tags": ["news", "talk"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "bbcws", "name": "BBC World Service",
     "url": "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service",
     "homepage": "https://www.bbc.co.uk/worldserviceradio",
     "tags": ["news", "talk"], "codec": "MP3", "bitrate": 56,
     "favicon": "", "country": "UK", "source": "preset"},
    {"id": "darksynth", "name": "Nightride Darksynth",
     "url": "https://stream.nightride.fm/darksynth.mp3", "homepage": "https://nightride.fm/darksynth",
     "tags": ["darksynth", "synthwave"], "codec": "MP3", "bitrate": 128,
     "favicon": "", "country": "USA", "source": "preset"},
    {"id": "ilovechill", "name": "I Love Chillhop",
     "url": "https://streams.ilovemusic.de/iloveradio17.mp3", "homepage": "https://www.ilovemusic.de",
     "tags": ["lofi", "chillhop"], "codec": "MP3", "bitrate": 192,
     "favicon": "", "country": "Germany", "source": "preset"},
    {"id": "somafm-lush", "name": "SomaFM Lush",
     "url": "https://ice1.somafm.com/lush-128-mp3", "homepage": "https://somafm.com/lush/",
     "tags": ["chillout", "vocal", "electronic"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/lush400.jpg", "country": "USA", "source": "preset"},
    {"id": "somafm-indiepop", "name": "SomaFM Indie Pop Rocks!",
     "url": "https://ice1.somafm.com/indiepop-128-mp3", "homepage": "https://somafm.com/indiepop/",
     "tags": ["indie", "pop", "rock"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/indiepop400.jpg", "country": "USA", "source": "preset"},
    {"id": "somafm-beatblender", "name": "SomaFM Beat Blender",
     "url": "https://ice1.somafm.com/beatblender-128-mp3", "homepage": "https://somafm.com/beatblender/",
     "tags": ["deep house", "downtempo"], "codec": "MP3", "bitrate": 128,
     "favicon": "https://somafm.com/img3/beatblender400.jpg", "country": "USA", "source": "preset"},
]


def presets() -> List[Dict[str, Any]]:
    """The curated starter stations (copies, so a caller cannot mutate them)."""
    return [dict(s) for s in PRESETS]


def _cache_put(cache: Dict[str, Any], key: str, value: tuple) -> None:
    cache.pop(key, None)
    cache[key] = value
    while len(cache) > MAX_CACHE_ENTRIES:
        cache.pop(next(iter(cache)))


def reset_caches() -> None:
    """Forget every cached response (tests; also handy after an outage)."""
    global _POPULAR, _rb_down_until
    with _LOCK:
        _SEARCH_CACHE.clear()
        _POPULAR = None
        _rb_down_until = 0.0


# ---------------------------------------------------------------------------
# Radio Browser client
# ---------------------------------------------------------------------------

# Windows reports the WSA codes, not the C library ones.
_UNREACHABLE_ERRNOS = {getattr(errno, n) for n in (
    "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "EADDRNOTAVAIL",
    "WSAENETUNREACH", "WSAEHOSTUNREACH", "WSAECONNREFUSED", "WSAEADDRNOTAVAIL") if hasattr(errno, n)}


def _unreachable(exc: BaseException) -> bool:
    """A failure another try will not fix (name gone, refused, not routable)."""
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, socket.gaierror):
        return True
    return isinstance(reason, ConnectionRefusedError) or (
        isinstance(reason, OSError) and getattr(reason, "errno", None) in _UNREACHABLE_ERRNOS)


def _rb_open(req: urllib.request.Request, timeout: float):
    """One Radio Browser request (tests replace this to fake the network)."""
    return urllib.request.build_opener(_FirstAddressHTTPSHandler()).open(req, timeout=timeout)


def _rb_json(path: str, params: Optional[Dict[str, Any]] = None) -> Tuple[Any, Optional[int]]:
    """GET a Radio Browser JSON endpoint, trying each mirror in turn.

    Returns ``(decoded_body, total)`` where ``total`` is ``X-RBtotal`` when the
    server sends one. Raises ``RadioUnavailable`` when no mirror answers.
    """
    global _rb_down_until
    query = ("?" + urllib.parse.urlencode(params)) if params else ""
    now = time.monotonic()
    if now < _rb_down_until:
        raise RadioUnavailable("radio-browser unreachable (recently failed)")
    deadline = now + RB_TOTAL_BUDGET
    last_err = "no servers configured"
    dead: set = set()
    refused = 0
    nxt = 0
    for attempt in range(RB_ROUNDS * len(RADIO_BROWSER_SERVERS)):
        if all(base in dead for base in RADIO_BROWSER_SERVERS):
            break
        while RADIO_BROWSER_SERVERS[nxt % len(RADIO_BROWSER_SERVERS)] in dead:
            nxt += 1
        base = RADIO_BROWSER_SERVERS[nxt % len(RADIO_BROWSER_SERVERS)]
        nxt += 1
        if attempt >= len(RADIO_BROWSER_SERVERS):
            time.sleep(RB_RETRY_PAUSE)
        left = deadline - time.monotonic()
        if left <= 0.5:
            if attempt == 0:
                last_err = "time budget used up"
            break
        req = urllib.request.Request(f"{base}/json/{path}{query}", headers={"User-Agent": UA})
        try:
            with _rb_open(req, timeout=min(SEARCH_TIMEOUT, left, RB_ATTEMPT_CAP)) as resp:
                body = resp.read()
                headers = getattr(resp, "headers", None) or {}
                total_h = headers.get("x-rbtotal") or headers.get("x-rb-total")
            data = json.loads(body.decode("utf-8", errors="replace"))
            try:
                total = int(total_h) if total_h is not None else None
            except (TypeError, ValueError):
                total = None
            return data, total
        except urllib.error.HTTPError as exc:
            last_err = str(exc)
            if 400 <= exc.code < 500 and exc.code != 429:
                dead.add(base)
                refused += 1
        except Exception as exc:  # dropped, reset, timed out, name gone
            last_err = str(exc)
            if _unreachable(exc):
                dead.add(base)
    if refused and refused == len(dead) and all(base in dead for base in RADIO_BROWSER_SERVERS):
        raise RadioUnavailable(f"radio-browser refused the request: {last_err}")
    _rb_down_until = time.monotonic() + RB_DOWN_COOLDOWN
    raise RadioUnavailable(f"radio-browser unreachable: {last_err}")


def _int_field(raw: Dict[str, Any], key: str) -> int:
    try:
        return int(raw.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _normalize_station(raw: Dict[str, Any], source: str) -> Optional[Dict[str, Any]]:
    """One Radio Browser row -> an Aura station row, or None when unusable."""
    if not isinstance(raw, dict):
        return None
    url = str(raw.get("url_resolved") or raw.get("url") or "").strip()
    if not url:
        return None
    # HLS cannot be played by a plain <audio> element without hls.js, and the
    # page has no such bundle: drop those rows instead of offering a dead link.
    if raw.get("hls") or url.lower().endswith(".m3u8") or ".m3u8?" in url.lower():
        return None
    tags = [t.strip() for t in str(raw.get("tags") or "").split(",") if t.strip()][:12]
    return {
        "id": (f"rb-{str(raw.get('stationuuid')).strip()}" if str(raw.get("stationuuid") or "").strip()
               else "rb-url-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]),
        "name": str(raw.get("name") or "").strip() or "Unnamed",
        "url": url,
        "homepage": str(raw.get("homepage") or ""),
        "tags": tags,
        "codec": str(raw.get("codec") or ""),
        "bitrate": _int_field(raw, "bitrate"),
        "favicon": str(raw.get("favicon") or ""),
        "country": str(raw.get("country") or ""),
        "countrycode": str(raw.get("countrycode") or "").upper(),
        "votes": _int_field(raw, "votes"),
        "clickcount": _int_field(raw, "clickcount"),
        "source": source,
    }


def search(q: str = "", tag: str = "", limit: int = 30, offset: int = 0) -> List[Dict[str, Any]]:
    """Radio Browser search, cached for an hour per query. Raises RadioUnavailable."""
    q = str(q or "").strip()[:120]
    tag = str(tag or "").strip()[:60]
    try:
        limit = max(1, min(100, int(limit)))
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        limit, offset = 30, 0
    key = json.dumps(["search", q, tag, limit, offset], sort_keys=True)
    now = time.time()
    with _LOCK:
        hit = _SEARCH_CACHE.get(key)
        if hit and now - hit[0] < SEARCH_CACHE_TTL:
            return [dict(s) for s in hit[1]]
    params: Dict[str, Any] = {"hidebroken": "true", "order": "clickcount",
                              "reverse": "true", "limit": limit, "offset": offset}
    if q:
        params["name"] = q
    if tag:
        params["tag"] = tag
    data, _ = _rb_json("stations/search", params)
    out: List[Dict[str, Any]] = []
    for raw in data if isinstance(data, list) else []:
        station = _normalize_station(raw, "radiobrowser")
        if station:
            out.append(station)
    with _LOCK:
        _cache_put(_SEARCH_CACHE, key, (now, [dict(s) for s in out]))
    return out


# ---------------------------------------------------------------------------
# Popular: presets first, then a quality-filtered Radio Browser page
# ---------------------------------------------------------------------------

_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]")
_FLAG_RE = re.compile("[\U0001F1E6-\U0001F1FF]{1,2}")
_TEST_RE = re.compile(r"(?i)(^|[\s,;:!.|-])test([\s,;:!.|-]|$|[?!])")
_REPEAT_RE = re.compile(r"(?i)\b([a-z\u00c0-\u024f]{3,})\s+\1\b")


def _spammy_name(name: str) -> bool:
    """Reject station names that read like spam, not like a radio station."""
    n = (name or "").strip()
    if not n or len(n) > 80:
        return True
    if _TEST_RE.search(n) or _REPEAT_RE.search(n):
        return True
    if len(_EMOJI_RE.findall(_FLAG_RE.sub("", n))) >= 2:
        return True
    letters = [ch for ch in n if ch.isalpha()]
    if len(n) >= 40 and letters and sum(ch.isupper() for ch in letters) / len(letters) > 0.85:
        return True
    return sum(n.count(ch) for ch in "|»•~★✦♦") >= 3


_CODEC_NOISE_RE = re.compile(
    r"(?:\d{2,3}k|mp3|aacp?\d*|mpa\d|ogg|flac|wma|320|256|192|128|128k|96|hq|hd|sd|official|stream)+$")


def _norm_name(name: str) -> str:
    n = re.sub(r"[^a-z0-9]+", "", (name or "").casefold())
    return _CODEC_NOISE_RE.sub("", n)


def _home_host(homepage: str) -> str:
    try:
        host = urllib.parse.urlparse(str(homepage or "")).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _dedup_key(name: str, homepage: str) -> Tuple[str, str]:
    return (_norm_name(name), _home_host(homepage))


def popular(limit: int = POPULAR_LIMIT) -> List[Dict[str, Any]]:
    """A ranked "popular" list: the curated presets first, then clean stations.

    Radio Browser's raw ``clickcount`` order is full of spam and vote-stuffed
    rows, so the station rows are filtered (name heuristics, one entry per
    name+homepage, a minimum known bitrate, a per-country cap). A network
    failure is not an error here: presets are still a useful answer.
    """
    global _POPULAR
    try:
        limit = max(1, min(60, int(limit)))
    except (TypeError, ValueError):
        limit = POPULAR_LIMIT
    with _LOCK:
        hit = _POPULAR
        if hit and time.time() - hit[0] < POPULAR_TTL:
            return [dict(s) for s in hit[1][:limit]]
    out: List[Dict[str, Any]] = [dict(p) for p in PRESETS[:limit]]
    seen = {_dedup_key(p["name"], p.get("homepage", "")) for p in PRESETS}
    seen |= {(_norm_name(p["name"]), "") for p in PRESETS}
    per_country: Dict[str, int] = {}
    try:
        rows = search("", "", limit=POPULAR_FETCH)
    except RadioUnavailable:
        rows = []
    for st in rows:
        if len(out) >= limit:
            break
        if st.get("source") != "radiobrowser":
            continue
        if not st.get("url") or _spammy_name(st.get("name", "")):
            continue
        bitrate = st.get("bitrate") or 0
        if isinstance(bitrate, int) and bitrate and bitrate < POPULAR_MIN_BITRATE:
            continue
        votes, clicks = st.get("votes") or 0, st.get("clickcount") or 0
        if clicks and votes > clicks * POPULAR_VOTES_PER_CLICK:
            continue
        key = _dedup_key(st.get("name", ""), st.get("homepage", ""))
        if key in seen:
            continue
        seen.add(key)
        cc = str(st.get("countrycode") or "")
        if cc and per_country.get(cc, 0) >= POPULAR_MAX_PER_COUNTRY:
            continue
        if cc:
            per_country[cc] = per_country.get(cc, 0) + 1
        out.append(st)
    with _LOCK:
        _POPULAR = (time.time(), [dict(s) for s in out])
    return out[:limit]


# ---------------------------------------------------------------------------
# Favorites (persisted JSON under <HERMES_HOME>/aura/)
# ---------------------------------------------------------------------------

def _fav_path():
    return config.aura_dir() / "radio_favorites.json"


def favorites() -> List[Dict[str, Any]]:
    try:
        data = json.loads(_fav_path().read_text(encoding="utf-8"))
        if not isinstance(data, list):
            raise ValueError("favorites must be a list")
        return [f for f in data if isinstance(f, dict)]
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise RadioError(f"could not read radio favorites: {exc}") from exc


def _save_favorites(items: List[Dict[str, Any]]) -> None:
    path = _fav_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".fav-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(items, fh, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def add_favorite(station: Dict[str, Any]) -> Dict[str, Any]:
    """Add (or replace) one favorite, keyed by id and by stream URL."""
    st = dict(station or {})
    st["source"] = st.get("source") or "custom"
    url = st.get("url")
    if not isinstance(url, str) or not url.strip():
        raise RadioError("station needs a url")
    st["url"] = url.strip()
    if st.get("id") not in (None, ""):
        st["id"] = str(st["id"])
    if not st.get("id"):
        st["id"] = "custom-" + hashlib.sha256(st["url"].encode("utf-8")).hexdigest()

    def same_url(u: Any) -> str:
        return str(u or "").strip().rstrip("/")

    with _LOCK:
        favs = favorites()
        favs = [f for f in favs if f.get("id") != st["id"] and same_url(f.get("url")) != same_url(st["url"])]
        favs.append(st)
        _save_favorites(favs)
    return st


def remove_favorite(sid: str) -> bool:
    with _LOCK:
        favs = favorites()
        keep = [f for f in favs if str(f.get("id")) != str(sid)]
        if len(keep) == len(favs):
            return False
        _save_favorites(keep)
        return True


# ---------------------------------------------------------------------------
# Stream URL safety (SSRF guard) — kept from REVamp
# ---------------------------------------------------------------------------

# NAT64 prefixes count as global, but a DNS64 gateway turns them into the IPv4
# address inside, so they are unwrapped (or refused for the local-use range).
_NAT64 = (ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48"))


def _public_answers(answers: list) -> list:
    """Every getaddrinfo answer must be a public address; returns them unchanged."""
    if not answers:
        raise RadioError("stream host could not be resolved")
    for answer in answers:
        try:
            address = ipaddress.ip_address(answer[4][0])
        except (IndexError, ValueError):
            raise RadioError("stream host returned an invalid address") from None
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        elif address.version == 6 and address in _NAT64[1]:
            raise RadioError("stream host is not a public address")
        elif address.version == 6 and address in _NAT64[0]:
            address = ipaddress.ip_address(int(address) & 0xFFFFFFFF)
        if not address.is_global:
            raise RadioError("stream host resolves to a non-public address")
    return answers


def _validate_stream_url(url: str) -> str:
    """Only public HTTP(S) streams.

    A playlist is upstream data, not a trusted redirect instruction: it must
    not turn a public ``.m3u`` request into a local-file or private-network
    read through Aura's server.
    """
    try:
        parsed = urllib.parse.urlsplit(str(url or ""))
    except ValueError as exc:
        raise RadioError("invalid stream URL") from exc
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise RadioError("stream URL must be public http(s)")
    if parsed.username is not None or parsed.password is not None:
        raise RadioError("stream URL credentials are not allowed")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        answers = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise RadioError("stream host could not be resolved") from exc
    _public_answers(answers)
    return url


def safe_stream_url(url: str) -> bool:
    """Whether *url* resolves only to public HTTP(S) stream endpoints."""
    try:
        _validate_stream_url(url)
        return True
    except RadioError:
        return False


def _connect_first(answers: Any, timeout: Any, source_address: Any = None) -> socket.socket:
    """Connect to the first address that answers, IPv4 first, short connect timeouts."""
    answers = sorted(answers, key=lambda a: a[0] != socket.AF_INET)
    full = socket.getdefaulttimeout() if timeout is socket._GLOBAL_DEFAULT_TIMEOUT else timeout  # type: ignore[attr-defined]
    deadline = None if full is None else time.monotonic() + full
    err: Optional[OSError] = None
    retryable: Optional[OSError] = None
    for i, (family, socktype, proto, _canon, addr) in enumerate(answers):
        left = None if deadline is None else deadline - time.monotonic()
        if left is not None and left <= 0:
            raise retryable or err or socket.timeout("timed out")
        sock = socket.socket(family, socktype, proto)
        last = i == len(answers) - 1
        try:
            if last:
                sock.settimeout(left)
            else:
                sock.settimeout(CONNECT_TIMEOUT if left is None else min(CONNECT_TIMEOUT, left / 2))
            if source_address:
                sock.bind(source_address)
            sock.connect(addr)
            sock.settimeout(full)
            return sock
        except OSError as exc:
            sock.close()
            err = exc
            if not _unreachable(exc):
                retryable = exc
    raise retryable or err or OSError("host could not be reached")


def _pinned_socket(host: str, port: int, timeout: Any, source_address: Any = None) -> socket.socket:
    """Resolve once, check, connect to exactly the checked address.

    Validating a URL and letting urllib resolve it again leaves a DNS
    rebinding gap: a zero-TTL record can answer public for the check and
    127.0.0.1 for the connect.
    """
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise RadioError("stream host could not be resolved") from exc
    return _connect_first(_public_answers(answers), timeout, source_address)


class _FirstAddressHTTPSConnection(http.client.HTTPSConnection):
    """Radio Browser over HTTPS, connecting with _connect_first."""

    def connect(self) -> None:
        if getattr(self, "_tunnel_host", None):
            return super().connect()
        t0 = time.monotonic()
        answers = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        sock = _connect_first(answers, self.timeout, self.source_address)
        if isinstance(self.timeout, (int, float)):
            sock.settimeout(max(0.5, self.timeout - (time.monotonic() - t0)))
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]
        if isinstance(self.timeout, (int, float)):
            self.sock.settimeout(max(0.5, self.timeout - (time.monotonic() - t0)))


class _FirstAddressHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):  # type: ignore[no-untyped-def]
        return self.do_open(_FirstAddressHTTPSConnection, req, context=self._context)  # type: ignore[attr-defined]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = _pinned_socket(self.host, self.port, self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self) -> None:
        sock = _pinned_socket(self.host, self.port, self.timeout, self.source_address)
        # TLS still verifies the certificate against the hostname, not the IP.
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):  # type: ignore[no-untyped-def]
        return self.do_open(_PinnedHTTPConnection, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):  # type: ignore[no-untyped-def]
        return self.do_open(_PinnedHTTPSConnection, req, context=self._context)  # type: ignore[attr-defined]


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Validate every target before urllib follows an HTTP redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        _validate_stream_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, headers: Dict[str, str], timeout: float):
    _validate_stream_url(url)
    req = urllib.request.Request(url, headers=headers)
    # Do not honour HTTP(S)_PROXY: the request goes only to the public target
    # that was just validated, through pinned handlers, so the address checked
    # is the address connected to (including each redirect hop).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SafeRedirect(),
                                         _PinnedHTTPHandler(), _PinnedHTTPSHandler())
    return opener.open(req, timeout=timeout)


def resolve_playlist_url(url: str) -> str:
    """If *url* points at a .pls/.m3u playlist file, return its first stream URL."""
    try:
        lowered = str(url or "").lower()
    except Exception:  # noqa: BLE001
        return ""
    if not (lowered.split("?")[0].endswith(".pls") or lowered.split("?")[0].endswith(".m3u")):
        return url
    try:
        with _open(url, {"User-Agent": UA}, PLAYLIST_TIMEOUT) as resp:
            # utf-8-sig: tools start playlists with a BOM, which made "#EXTM3U" a URL.
            text = resp.read(64 * 1024).decode("utf-8-sig", errors="replace")
            geturl = getattr(resp, "geturl", None)
            base = (geturl() if callable(geturl) else None) or url
    except Exception:  # noqa: BLE001 - an unreadable playlist is not fatal
        return url
    m = re.search(r"^File\d+\s*=\s*(\S+)", text, re.M | re.I)
    if m:
        candidate = urllib.parse.urljoin(base, m.group(1).strip())
        return candidate if safe_stream_url(candidate) else url
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            candidate = urllib.parse.urljoin(base, line)
            return candidate if safe_stream_url(candidate) else url
    return url


def prepare_stream(url: str) -> str:
    """Validate a stream URL (resolving .pls/.m3u) or raise RadioError.

    Used by every entry point that is about to hand a URL to the page, so a
    private address can never reach the browser's ``<audio>`` element either.
    """
    raw = str(url or "").strip()
    if not raw:
        raise RadioError("a stream url is required")
    if not safe_stream_url(raw):
        raise RadioError("stream url must be public http(s)")
    target = resolve_playlist_url(raw)
    if not safe_stream_url(target):
        raise RadioError("resolved stream url must be public http(s)")
    return target


STREAM_TIMEOUT = 15.0


def open_stream(url: str, timeout: float = STREAM_TIMEOUT):
    """Validate, resolve and open a radio stream through the pinned opener.

    The browser never sees the station hostname: the server streams these
    bytes to ``/api/radio/stream``. Redirect hops are checked by
    ``_SafeRedirect`` and the socket is pinned to the address that was
    validated, so a station cannot redirect the page to ``127.0.0.1``.
    """
    target = prepare_stream(url)
    return _open(target, {"User-Agent": UA, "Accept": "*/*", "Icy-MetaData": "0"},
                 timeout)
