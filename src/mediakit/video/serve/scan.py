"""Discover video files anywhere under a library root.

Walks the library root recursively and picks up any file whose extension
matches the supported video set. There is no `videos/` subdirectory
convention — users point at one directory and we scan both audio and
video from the same root.

Duration is probed lazily via ffprobe and cached per file path so the
listing endpoint doesn't pay the probe cost on every request, but also
doesn't pre-probe an entire 1000-file library at startup.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict

# Common container formats; broader than the original set to cover
# user libraries with mixed-source content (.flv from YouTube rips,
# .mpg/.mpeg DVDs, .vob raw DVD tracks, .mts/.3gp camcorder/phone
# captures, .ogv/.asf older container formats, .divx packaged
# files). Subtitle-image-only codecs are still filtered downstream
# by ffmpeg, not here.
VIDEO_EXTENSIONS = frozenset(
    {
        ".mkv",
        ".mp4",
        ".m4v",
        ".webm",
        ".mov",
        ".avi",
        ".ts",
        ".m2ts",
        ".mts",
        ".wmv",
        ".flv",
        ".mpg",
        ".mpeg",
        ".vob",
        ".ogv",
        ".3gp",
        ".3g2",
        ".asf",
        ".divx",
    }
)

# Directories we never descend into when scanning. `.mediakit` is the
# server's own cache (poster art, SQLite index, HLS segments — none
# are library content). Dotfiles and the audio app's expected
# `.musickit` legacy location are also skipped.
_SCAN_SKIP_DIR_NAMES = frozenset({".mediakit", ".musickit", ".git", "__pycache__"})

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


class FolderEntry(TypedDict):
    """One subdirectory in a browse response."""

    name: str
    rel_path: str
    video_count: int  # videos in this folder and all descendants


class BrowseResponse(TypedDict):
    """Result of browsing one directory under the library root."""

    rel_path: str  # "" means the library root, "movies" / "tv/The Americans" etc.
    crumbs: list[str]  # ["movies"] or ["tv", "The Americans", "Season 1"]; "" -> []
    folders: list[FolderEntry]
    videos: list[VideoEntry]


def _iter_video_files(root: Path) -> Iterator[Path]:
    """Yield every video file under root, skipping internal cache dirs."""
    if not root.is_dir():
        return
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for child in entries:
            if child.is_dir():
                if child.name in _SCAN_SKIP_DIR_NAMES:
                    continue
                stack.append(child)
            elif child.is_file() and child.suffix.lower() in VIDEO_EXTENSIONS:
                yield child


def scan_videos(root: Path) -> list[VideoEntry]:
    """Walk root recursively and return one entry per video file.

    IDs are derived from the path under the library root so they're stable
    across rescans (until the file is renamed or moved).
    """
    if not root.is_dir():
        return []
    out: list[VideoEntry] = []
    for path in sorted(_iter_video_files(root)):
        rel = path.relative_to(root)
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


def has_videos(root: Path) -> bool:
    """Cheap check: does the library root contain at least one video file?

    Stops at the first match so an empty mount decision doesn't pay for a
    full library walk.
    """
    return next(_iter_video_files(root), None) is not None


def browse_dir(root: Path, rel_path: str = "") -> BrowseResponse | None:
    """List immediate children of <root>/<rel_path>/ for the SPA browser.

    Returns folders (non-empty, containing at least one video somewhere in
    their subtree) and videos in the current directory. Subtree video
    counts let the SPA show a folder weight (e.g. "Season 1 - 13 videos").

    rel_path is a POSIX-style path relative to the library root.
    Empty string means the library root. Returns None when:
    - the resolved target is outside the library root (path traversal)
    - the target doesn't exist or isn't a directory
    """
    if not root.is_dir():
        return None
    target = (root / rel_path).resolve()
    base = root.resolve()
    # Guard against `..` escapes - the resolved target must remain inside
    # the library root tree.
    if target != base and base not in target.parents:
        return None
    if not target.is_dir():
        return None

    from mediakit.video.serve.subtitles import discover_sidecars

    folders: list[FolderEntry] = []
    videos: list[VideoEntry] = []
    for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
        child_rel = child.relative_to(root)
        if child.is_dir():
            if child.name in _SCAN_SKIP_DIR_NAMES:
                continue
            count = _count_videos(child)
            if count == 0:
                # Hide empty subdirs (e.g. proof / nfo dirs, or audio-only
                # folders when scanning a mixed library) from the browser.
                continue
            folders.append(
                FolderEntry(
                    name=child.name,
                    rel_path=child_rel.as_posix(),
                    video_count=count,
                )
            )
        elif child.is_file() and child.suffix.lower() in VIDEO_EXTENSIONS:
            from mediakit.video.serve.subtitles import probe_embedded_subtitles

            # Embedded subtitle probe is ~50-100ms via ffprobe but the
            # result is process-cached (per-path), so this is fast after
            # the prewarm task warms it. Cold first browse pays the
            # ffprobe cost; subsequent calls are instant.
            sidecars = discover_sidecars(child)
            embedded = probe_embedded_subtitles(child)
            videos.append(
                VideoEntry(
                    id=_make_id(child_rel),
                    name=child.stem,
                    path=str(child),
                    size_bytes=child.stat().st_size,
                    rel_path=child_rel.as_posix(),
                    duration_s=probe_duration(child),
                    subtitles=[SubtitleSummary(lang=s.language, format=s.fmt) for s in sidecars]
                    + [SubtitleSummary(lang=e.language, format=e.codec_name) for e in embedded],
                )
            )

    crumbs = [c for c in rel_path.split("/") if c]
    return BrowseResponse(
        rel_path=rel_path,
        crumbs=crumbs,
        folders=folders,
        videos=videos,
    )


def _count_videos(dir_path: Path) -> int:
    """Count video files at every depth under `dir_path`. Cheap stat-only walk."""
    count = 0
    for _ in _iter_video_files(dir_path):
        count += 1
    return count


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
    """Stable, URL-safe id from the file's path relative to the library root.

    Format: `<slug>-<8-hex-hash>` where:
      - `slug` keeps the existing readable transformation (extension stripped,
        `/` -> `-`) so server logs and cache filenames stay debuggable.
      - The 8-hex SHA256 prefix of the full rel_path makes the id
        collision-free: paths like `tv/ch01.mkv` and `tv-ch01.mkv` (a
        literal hyphen in a flat filename) used to collapse to the same
        slug `tv-ch01`, and the first match won at lookup time — so the
        second video was unreachable AND its HLS / poster / subtitle
        cache entries collided with the first's. The hash suffix breaks
        the tie deterministically.
    """
    import hashlib

    full = rel_path.as_posix()
    digest = hashlib.sha256(full.encode("utf-8")).hexdigest()[:8]
    slug = rel_path.with_suffix("").as_posix().replace("/", "-")
    return f"{slug}-{digest}"
