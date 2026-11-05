"""Token redaction helpers.

The Aura token is a bearer credential for a loopback HTTP server. It appears in
URLs (``?token=…``) and, if anybody is careless, in log lines. Every path that
shows a URL to a human or to the model must go through this module first.

Masking rule: keep the first four and last four characters, join with a single
ellipsis. Anything shorter than 9 characters is masked entirely, because
first4+last4 would otherwise leak most of it.
"""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit, urlunsplit

_MASK = "\u2026"  # ellipsis

_TOKEN_KEYS = ("token", "access_token", "auth", "key", "apikey", "api_key")


def mask_token(token: str | None) -> str:
    """``abcd…wxyz`` for long tokens, ``****`` for short/empty ones."""
    if not token:
        return "****"
    text = str(token)
    if len(text) < 9:
        return "*" * max(4, min(len(text), 8))
    return f"{text[:4]}{_MASK}{text[-4:]}"


def _mask_query(parts) -> list:
    """Kept for callers that already have parsed pairs (unused by redact_url)."""
    out = []
    for key, value in parts:
        if key.lower() in _TOKEN_KEYS and value:
            out.append((key, mask_token(value)))
        else:
            out.append((key, value))
    return out


def redact_url(url: str) -> str:
    """Mask the token value in a URL, keeping scheme/host/port/path intact.

    The mask is written literally (``abcd…wxyz``), NOT re-encoded: running the
    query through ``urlencode`` percent-encodes the ellipsis into ``%E2%80%A6``,
    which reads as garbage in a model-facing status payload.
    """
    if not isinstance(url, str) or not url:
        return url
    try:
        split = urlsplit(url)
    except ValueError:
        return url
    if not split.query:
        return url
    parts = []
    for pair in split.query.split("&"):
        if not pair:
            continue
        key, sep, value = pair.partition("=")
        try:
            decoded = unquote(value)
        except (TypeError, ValueError):
            decoded = value
        if sep and key.lower() in _TOKEN_KEYS and decoded:
            parts.append(f"{key}={mask_token(decoded)}")
        else:
            parts.append(pair)
    return urlunsplit((split.scheme, split.netloc, split.path, "&".join(parts), split.fragment))


def redact_text(text: str, token: str | None = None) -> str:
    """Mask every literal occurrence of ``token`` in free text (e.g. a log line)."""
    if not isinstance(text, str) or not text:
        return text
    out = text
    if token:
        out = out.replace(str(token), mask_token(token))
    # Belt and braces: any token=… left in a URL-ish string.
    return re.sub(
        r"(?i)([?&](?:token|access_token|auth|apikey|api_key)=)([^&\s\"'<>]+)",
        lambda m: m.group(1) + mask_token(m.group(2)),
        out,
    )


def redact_headers(headers) -> dict:
    """Copy a header mapping with ``Authorization`` masked (for debug logging)."""
    try:
        items = dict(headers)
    except (TypeError, ValueError):
        return {}
    for key in list(items):
        if key.lower() == "authorization":
            value = str(items[key])
            scheme, _, credential = value.partition(" ")
            items[key] = f"{scheme} {mask_token(credential)}" if credential else mask_token(value)
    return items
