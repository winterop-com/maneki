"""Discover video files under <root>/videos/.

Permissive about the subdirectory name (videos/, video/, case-insensitive)
and the layout inside (flat, Movies/, Shows/, anything).
"""

from __future__ import annotations

from pathlib import Path
from typing import TypedDict

VIDEO_EXTENSIONS = frozenset({".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv"})

VIDEOS_DIR_CANDIDATES = ("videos", "video")


class VideoEntry(TypedDict):
    """Metadata for one indexed video file."""

    id: str
    name: str
    path: str
    size_bytes: int
    rel_path: str


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
        out.append(
            VideoEntry(
                id=_make_id(rel),
                name=path.stem,
                path=str(path),
                size_bytes=path.stat().st_size,
                rel_path=str(rel),
            )
        )
    return out


def _make_id(rel_path: Path) -> str:
    """Stable, URL-safe id from the file's path relative to the videos dir.

    Keeps the stem readable so logs are debuggable; replaces path separators
    with hyphens so the id is a single slug.
    """
    return rel_path.with_suffix("").as_posix().replace("/", "-")
