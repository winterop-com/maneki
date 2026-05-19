"""Subtitle sidecar discovery + .srt to WebVTT conversion.

A sidecar is a subtitle file living next to a video with the same stem:

    videos/bat.mp4
    videos/bat.srt              -> language "und" (undetermined)
    videos/bat.en.srt           -> language "en"
    videos/bat.eng.srt          -> language "eng"
    videos/bat.fr.forced.srt    -> language "fr" (modifier ignored for v0)

Browsers can't render .srt natively but can render WebVTT (.vtt) via the
HTML5 <track> element. We serve every sidecar as WebVTT, converting on
the fly when the source is .srt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

SUBTITLE_EXTENSIONS = frozenset({".srt", ".vtt"})


@dataclass(frozen=True)
class SubtitleSidecar:
    """One subtitle file associated with a video."""

    path: Path
    language: str
    fmt: str  # "srt" or "vtt"


_LANG_TAG = re.compile(r"^[a-z]{2,3}$")


def discover_sidecars(video_path: Path) -> list[SubtitleSidecar]:
    """Find all subtitle files next to the given video.

    Looks for files in the same directory whose stem starts with the video's
    stem followed by an optional `.<lang>` (and optional modifiers we ignore).
    Returns one SubtitleSidecar per discovered file.
    """
    if not video_path.is_file():
        return []
    base = video_path.stem
    parent = video_path.parent
    out: list[SubtitleSidecar] = []
    for sibling in sorted(parent.iterdir()):
        if not sibling.is_file():
            continue
        ext = sibling.suffix.lower()
        if ext not in SUBTITLE_EXTENSIONS:
            continue
        lang = _extract_language(sibling.stem, base)
        if lang is None:
            continue
        out.append(SubtitleSidecar(path=sibling, language=lang, fmt=ext.lstrip(".")))
    return out


def _extract_language(sub_stem: str, video_stem: str) -> str | None:
    """Return the language code for a sidecar whose stem extends the video stem.

    `bat.srt` (stem 'bat') for video 'bat' -> "und".
    `bat.en.srt` (stem 'bat.en') for video 'bat' -> "en".
    `bat.fr.forced.srt` (stem 'bat.fr.forced') for video 'bat' -> "fr".
    Returns None if the stem isn't related to the video stem.
    """
    if sub_stem == video_stem:
        return "und"
    prefix = video_stem + "."
    if not sub_stem.startswith(prefix):
        return None
    tail = sub_stem[len(prefix) :]
    # First dot-separated piece is the language; modifiers (.forced, .sdh) follow.
    head = tail.split(".", 1)[0].lower()
    if _LANG_TAG.match(head):
        return head
    # Not a language tag -> still associated but undetermined.
    return "und"


def to_webvtt(source_path: Path) -> str:
    """Return the subtitle file's contents as WebVTT.

    .vtt is returned as-is; .srt is converted minimally (timestamps + header).
    Anything else returns the raw text - the browser will reject it cleanly.
    """
    text = source_path.read_text(encoding="utf-8", errors="replace")
    ext = source_path.suffix.lower()
    if ext == ".vtt":
        return _ensure_webvtt_header(text)
    if ext == ".srt":
        return srt_to_vtt(text)
    return text


def srt_to_vtt(srt_text: str) -> str:
    """Minimal SubRip-to-WebVTT conversion.

    Differences handled:
      - WEBVTT header prepended (required by the spec)
      - Timestamps use '.' for the millisecond separator, not ','
      - SubRip cue indices (the bare numbers above each cue) are valid in
        WebVTT but optional; we leave them in place

    Anything else SubRip-specific (HTML tags, positioning) passes through;
    browsers tolerate the rest of the SubRip syntax under WebVTT parsing.
    """
    converted = re.sub(r"(\d\d:\d\d:\d\d),(\d{3})", r"\1.\2", srt_text)
    return "WEBVTT\n\n" + converted.lstrip("﻿").lstrip()


def _ensure_webvtt_header(text: str) -> str:
    """Defensive: many .vtt files in the wild are missing the WEBVTT magic line."""
    stripped = text.lstrip("﻿").lstrip()
    if stripped.startswith("WEBVTT"):
        return stripped
    return "WEBVTT\n\n" + stripped
