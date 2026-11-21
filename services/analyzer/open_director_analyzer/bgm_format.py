"""BGM format support predicate (MIT, derived from adudir-open)."""

from __future__ import annotations

import os

SUPPORTED_BGM_EXTS: frozenset[str] = frozenset({".mp3", ".m4a", ".aac", ".ogg", ".wav"})

KNOWN_UNSUPPORTED_EXTS: frozenset[str] = frozenset({
    ".wma", ".aiff", ".aif", ".alac", ".ape", ".opus", ".amr", ".mid", ".midi",
})


def bgm_ext(filename: str = "", remote_url: str = "") -> str:
    src = filename or remote_url.split("?")[0].split("#")[0]
    return os.path.splitext(src)[1].lower()


def is_supported_bgm(filename: str = "", remote_url: str = "") -> bool:
    ext = bgm_ext(filename, remote_url)
    if ext in SUPPORTED_BGM_EXTS:
        return True
    if ext in KNOWN_UNSUPPORTED_EXTS:
        return False
    return True


def unsupported_reason(filename: str = "", remote_url: str = "") -> str:
    if is_supported_bgm(filename, remote_url):
        return ""
    ext = bgm_ext(filename, remote_url) or "(no extension)"
    return f"Format {ext} is not supported for browser preview/export; use mp3, m4a, aac, ogg, or wav."
