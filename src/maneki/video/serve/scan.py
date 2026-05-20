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

import asyncio
import functools
import json
import logging
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from maneki.video.serve.scan_state import VideoScanTracker

log = logging.getLogger(__name__)

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

# Directories we never descend into when scanning. `.maneki` is the
# server's own cache (poster art, SQLite index, HLS segments — none
# are library content). Dotfiles and the audio app's expected
# `.musickit` legacy location are also skipped.
_SCAN_SKIP_DIR_NAMES = frozenset({".maneki", ".musickit", ".git", "__pycache__"})

# Cap on the in-memory duration cache. A 20k-entry LRU keeps the
# steady-state library probe O(1) without growing unbounded on a
# long-running server that's watched a library through many rescans /
# renames. Eviction reverts to a fresh ffprobe (~100ms), which is
# acceptable for a cold-miss on a library larger than the cap.
_DURATION_CACHE_MAX = 20000


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


def scan_videos(root: Path, *, probe: bool = True) -> list[VideoEntry]:
    """Walk root recursively and return one entry per video file.

    IDs are derived from the path under the library root so they're stable
    across rescans (until the file is renamed or moved).

    `probe=True` (default) calls ffprobe per file to populate `duration_s`
    - fine for small libraries and for endpoints that need duration, but
    expensive on a 1000+ file library (one ffprobe subprocess per file
    on cold scan). `probe=False` returns `duration_s=None` for every
    entry, makes the scan a stat-only walk, and lets the duration be
    filled in lazily on first use. Server startup uses probe=False so
    a big library doesn't spawn a thousand ffprobes just to know what's
    there.
    """
    if not root.is_dir():
        return []
    out: list[VideoEntry] = []
    for path in sorted(_iter_video_files(root)):
        rel = path.relative_to(root)
        from maneki.video.serve.subtitles import discover_sidecars

        sidecars = discover_sidecars(path)
        out.append(
            VideoEntry(
                id=_make_id(rel),
                name=path.stem,
                path=str(path),
                size_bytes=path.stat().st_size,
                rel_path=str(rel),
                duration_s=probe_duration(path) if probe else None,
                subtitles=[SubtitleSummary(lang=s.language, format=s.fmt) for s in sidecars],
            )
        )
    return out


# Concurrent ffprobes during prewarm. Each probe is ~50-300ms wall-clock
# (mostly I/O / ffprobe startup) so high concurrency moves the needle on
# a cold library; the cap stops a 10k-file library from spawning 10k
# subprocesses at once and exhausting file descriptors.
_PREWARM_PROBE_CONCURRENCY = 8

# How often the prewarm emits a terminal heartbeat log line during the
# walk + probe phases. Without these the user running `maneki serve` on
# a big / slow library sees nothing between "walking" and "complete" -
# which on a 10k-file USB drive can be minutes.
_WALK_LOG_EVERY = 250
_PROBE_LOG_EVERY = 50


async def prewarm_scan(root: Path, tracker: VideoScanTracker) -> list[VideoEntry]:
    """Walk the library, probe every file, and report progress on the tracker.

    Two-phase, both reported live to the SPA progressbar:

    1. **Walk** — directory traversal. We tick `walked` per file as it's
       discovered so the SPA shows "discovering: N files" instead of an
       opaque pulse. On deep trees the walk itself takes a few seconds.

    2. **Probe** — ffprobe each file for duration + sidecar discovery.
       Parallelised at `_PREWARM_PROBE_CONCURRENCY` so a 1000-file
       library finishes in ~25s instead of ~200s (each ffprobe is
       ~100-200ms wall-clock, dominated by subprocess startup). Each
       probe ticks `scanned` so the progressbar advances live.

    The walk runs in a single worker thread (cheap, sequential is fine).
    Probes are awaitable; gather + Semaphore caps in-flight work.
    Populates `probe_duration`'s LRU cache as a side effect, so the next
    `scan_videos(root)` is effectively a cache hit.

    Caller is expected to put this on a `lifespan` startup task and stash
    the returned list on `app.state` for the listing endpoints to read.
    """
    log.info("video scan: walking %s", root)
    tracker.begin_walk()

    paths: list[Path] = []

    def _walk_with_progress() -> None:
        # Append + tick inline so the SPA sees the count grow live.
        # `tracker.walk_tick` is just an int increment; safe from a
        # worker thread under GIL semantics. Periodically also log a
        # terminal heartbeat so a `maneki serve /huge/library` shows
        # forward motion in stdout, not just a long silence.
        for p in _iter_video_files(root):
            paths.append(p)
            tracker.walk_tick()
            if len(paths) % _WALK_LOG_EVERY == 0:
                log.info("video scan: walked %d files so far...", len(paths))
        paths.sort()

    await asyncio.to_thread(_walk_with_progress)
    tracker.set_total(len(paths))
    log.info(
        "video scan: walk done, found %d files; probing durations (concurrency=%d)",
        len(paths),
        _PREWARM_PROBE_CONCURRENCY,
    )

    from maneki.video.serve.subtitles import discover_sidecars

    sem = asyncio.Semaphore(_PREWARM_PROBE_CONCURRENCY)
    out: list[VideoEntry | None] = [None] * len(paths)
    total = len(paths)

    async def _probe_one(i: int, path: Path) -> None:
        async with sem:
            duration = await asyncio.to_thread(probe_duration, path)
            sidecars = await asyncio.to_thread(discover_sidecars, path)
            rel = path.relative_to(root)
            out[i] = VideoEntry(
                id=_make_id(rel),
                name=path.stem,
                path=str(path),
                size_bytes=path.stat().st_size,
                rel_path=str(rel),
                duration_s=duration,
                subtitles=[SubtitleSummary(lang=s.language, format=s.fmt) for s in sidecars],
            )
            tracker.tick()
            # `_scanned` is incremented atomically under GIL; reading it
            # right after the bump is fine for a "did we hit a log-worthy
            # multiple?" check, even under high concurrency.
            done = tracker.snapshot().scanned
            if done % _PROBE_LOG_EVERY == 0 or done == total:
                log.info("video scan: probed %d / %d files", done, total)

    await asyncio.gather(*(_probe_one(i, p) for i, p in enumerate(paths)))
    tracker.finish()
    # All slots filled by the time gather() returns, but the type checker
    # doesn't know that; the cast lets the function signature stay clean.
    results: list[VideoEntry] = [e for e in out if e is not None]
    log.info("video scan: complete (%d videos)", len(results))
    return results


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

    from maneki.video.serve.subtitles import discover_sidecars

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
            from maneki.video.serve.subtitles import probe_embedded_subtitles

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


@functools.lru_cache(maxsize=_DURATION_CACHE_MAX)
def probe_duration(path: Path) -> float | None:
    """Return the file's duration in seconds via ffprobe; cached per path.

    Returns None if ffprobe is missing, the file can't be parsed, or the
    duration field is absent. The cache is bounded by `_DURATION_CACHE_MAX`
    (LRU eviction) so a long-running server watching a churning library
    doesn't grow this dict without bound.
    """
    return _probe_duration_uncached(path)


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
            stdin=subprocess.DEVNULL,
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
