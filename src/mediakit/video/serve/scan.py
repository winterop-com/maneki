"""Discover video files under <root>/videos/.

Permissive about the subdirectory name (videos/, video/, case-insensitive)
and the layout inside (flat, Movies/, Shows/, anything).

Duration is probed lazily via ffprobe and cached per file path so the
listing endpoint doesn't pay the probe cost on every request, but also
doesn't pre-probe an entire 1000-file library at startup.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import TypedDict

VIDEO_EXTENSIONS = frozenset({".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv"})

VIDEOS_DIR_CANDIDATES = ("videos", "video")

_DURATION_CACHE: dict[str, float | None] = {}


class SubtitleSummary(TypedDict):
    """One subtitle sidecar surfaced in the video list response."""

    lang: str
    format: str  # "srt" or "vtt"


class VideoEntry(TypedDict):
    """Metadata for one indexed video file."""

    id: str
    name: str
    path: str
    size_bytes: int
    rel_path: str
    duration_s: float | None
    subtitles: list[SubtitleSummary]


def find_videos_dir(root: Path) -> Path | None:
    """Return the videos subdirectory under root, or None if none present.

    Matches 'videos' or 'video' case-insensitively. Returns the first match.
    """
    for child in root.iterdir() if root.is_dir() else ():
        if child.is_dir() and child.name.lower() in VIDEOS_DIR_CANDIDATES:
            return child
    return None


def scan_videos(root: Path) -> list[VideoEntry]:
    """Walk <root>/videos/ and return one entry per video file.

    IDs are derived from the path under the videos directory so they're stable
    across rescans (until the file is renamed or moved).
    """
    videos_dir = find_videos_dir(root)
    if videos_dir is None:
        return []
    out: list[VideoEntry] = []
    for path in sorted(videos_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        rel = path.relative_to(videos_dir)
        from mediakit.video.serve.subtitles import discover_sidecars

        sidecars = discover_sidecars(path)
        out.append(
            VideoEntry(
                id=_make_id(rel),
                name=path.stem,
                path=str(path),
                size_bytes=path.stat().st_size,
                rel_path=str(rel),
                duration_s=probe_duration(path),
                subtitles=[SubtitleSummary(lang=s.language, format=s.fmt) for s in sidecars],
            )
        )
    return out


def probe_duration(path: Path) -> float | None:
    """Return the file's duration in seconds via ffprobe; cached per path.

    Returns None if ffprobe is missing, the file can't be parsed, or the
    duration field is absent. Cache key is the absolute path string - the
    cache is shared across the process and survives until restart.
    """
    key = str(path)
    if key in _DURATION_CACHE:
        return _DURATION_CACHE[key]
    duration = _probe_duration_uncached(path)
    _DURATION_CACHE[key] = duration
    return duration


def _probe_duration_uncached(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603 - args are constructed locally
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
        return None


def _make_id(rel_path: Path) -> str:
    """Stable, URL-safe id from the file's path relative to the videos dir.

    Keeps the stem readable so logs are debuggable; replaces path separators
    with hyphens so the id is a single slug.
    """
    return rel_path.with_suffix("").as_posix().replace("/", "-")
