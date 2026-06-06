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
import hashlib
import json
import logging
import shutil
import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from maneki.video.serve.scan_cache import VideoIndex
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


class SubtitleSummary(BaseModel):
    """One subtitle sidecar surfaced in the video list response."""

    lang: str
    format: str  # "srt" or "vtt"


class VideoEntry(BaseModel):
    """Metadata for one indexed video file."""

    id: str
    name: str
    path: str
    size_bytes: int
    rel_path: str
    duration_s: float | None
    subtitles: list[SubtitleSummary]


class FolderEntry(BaseModel):
    """One subdirectory in a browse response."""

    name: str
    rel_path: str
    video_count: int  # videos in this folder and all descendants


class BrowseResponse(BaseModel):
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
            elif child.is_file() and not child.name.startswith(".") and child.suffix.lower() in VIDEO_EXTENSIONS:
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


async def prewarm_scan(
    root: Path,
    tracker: VideoScanTracker,
    *,
    index: VideoIndex | None = None,
    on_changed: Callable[[str], object] | None = None,
) -> list[VideoEntry]:
    """Walk the library, probe new/changed files, return the full list.

    With `index` supplied (the persistent SQLite cache), this is the
    delta-scan path: walk the filesystem, compare each file's (mtime,
    size_bytes) against the cached fingerprint, and only ffprobe files
    that are new or have changed on disk. Cached rows are reused as-is.
    Deleted files are pruned from the index. Result is the union of
    reused cache entries + freshly probed entries.

    Without `index` (tests, direct sub-app use), the legacy path runs:
    ffprobe every file every call.

    `on_changed` (optional) is invoked once per video id whose
    fingerprint moved relative to the cached row — i.e. files that
    existed last scan but were edited in place. Callers wire this to
    PosterManager.invalidate so the stale poster + thumbnail get
    dropped and regenerate from the new content. Brand-new files do
    NOT trigger it (no cache to invalidate).

    Two-phase, both reported live to the SPA progressbar:

    1. **Walk** — directory traversal. We tick `walked` per file as it's
       discovered so the SPA shows "discovering: N files" instead of an
       opaque pulse.

    2. **Probe** — ffprobe new / changed files only. With a warm cache
       a follow-up rescan touches ffmpeg only for files the user
       actually added or modified, so a 10k-file library that took
       ~20s on first start completes in milliseconds on restart.

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

    # Pre-stat the on-disk fingerprint for every walked file so the diff
    # against the cache runs without needing a stat per probe. Single
    # syscall per file, cheap.
    def _stat_all(ps: list[Path]) -> list[tuple[int, float]]:
        out: list[tuple[int, float]] = []
        for p in ps:
            try:
                st = p.stat()
                out.append((st.st_size, st.st_mtime))
            except OSError:
                out.append((-1, -1.0))
        return out

    fingerprints_disk = await asyncio.to_thread(_stat_all, paths)

    cached_entries: dict[str, VideoEntry] = {}
    cached_fingerprints: dict[str, tuple[float, int]] = {}
    if index is not None:
        cached_entries = await asyncio.to_thread(index.load_all)
        cached_fingerprints = await asyncio.to_thread(index.fingerprints)

    # Decide per file: reuse cache (no probe needed) vs. re-probe.
    reused: list[VideoEntry] = []
    to_probe: list[tuple[int, Path, int, float]] = []  # (idx, path, size, mtime)
    for i, path in enumerate(paths):
        size_bytes, mtime = fingerprints_disk[i]
        rel = path.relative_to(root)
        vid = _make_id(rel)
        prior = cached_fingerprints.get(vid)
        if prior is not None and prior == (mtime, size_bytes) and vid in cached_entries:
            # Same id, same fingerprint -> reuse. The cached entry's
            # `path` and `name` were derived from the same rel_path so
            # they're still correct even if the absolute root moved.
            reused.append(cached_entries[vid])
            tracker.tick()
        else:
            to_probe.append((i, path, size_bytes, mtime))
            # In-place edit: cached row exists but fingerprint moved.
            # The DB row will refresh from the upcoming probe, but the
            # cached poster PNG / thumbnail JPEG are keyed by the
            # path-derived id and would otherwise show stale frames
            # from the pre-edit content. Tell the caller to drop them
            # so the next /poster or /thumbnail request regenerates.
            # Brand-new files (prior is None) skip this — no cache to
            # invalidate.
            if on_changed is not None and prior is not None:
                try:
                    on_changed(vid)
                except Exception as exc:  # noqa: BLE001 - one bad invalidate mustn't block the scan
                    log.warning("video scan: on_changed callback failed for %s: %s", vid, exc)

    log.info(
        "video scan: walk done, found %d files; %d cached reused, %d to probe (concurrency=%d)",
        len(paths),
        len(reused),
        len(to_probe),
        _PREWARM_PROBE_CONCURRENCY,
    )

    from maneki.video.serve.subtitles import discover_sidecars

    sem = asyncio.Semaphore(_PREWARM_PROBE_CONCURRENCY)
    probed: list[VideoEntry | None] = [None] * len(to_probe)
    total_to_probe = len(to_probe)

    # Slot-aligned mtimes so the batch upsert at the end can pair each
    # probed entry with the on-disk mtime that triggered the probe.
    mtimes: list[float | None] = [None] * len(to_probe)

    async def _probe_one(slot: int, path: Path, size_bytes: int, mtime: float) -> None:
        async with sem:
            duration = await asyncio.to_thread(probe_duration, path)
            sidecars = await asyncio.to_thread(discover_sidecars, path)
            rel = path.relative_to(root)
            entry = VideoEntry(
                id=_make_id(rel),
                name=path.stem,
                path=str(path),
                size_bytes=size_bytes,
                rel_path=str(rel),
                duration_s=duration,
                subtitles=[SubtitleSummary(lang=s.language, format=s.fmt) for s in sidecars],
            )
            probed[slot] = entry
            mtimes[slot] = mtime
            tracker.tick()
            done = tracker.snapshot().scanned
            if done % _PROBE_LOG_EVERY == 0 or done == len(paths):
                log.info("video scan: probed %d / %d files", done, len(paths))

    await asyncio.gather(
        *(_probe_one(slot, path, size_bytes, mtime) for slot, (_, path, size_bytes, mtime) in enumerate(to_probe))
    )

    # Single-transaction batch upsert. Replaces the previous per-probe
    # `await asyncio.to_thread(index.upsert, ...)` pattern which was
    # observed to wedge the last ~8 tasks of a 1300+ file scan: 8
    # concurrent probes would all enter the upsert at the gather's
    # tail end and never return, leaving phase=probing at 1305/1313
    # indefinitely. One BEGIN/COMMIT per scan is also dramatically
    # cheaper — 1313 upserts inside a single transaction takes
    # milliseconds vs hundreds of small autocommit transactions each
    # forcing an fsync (synchronous=NORMAL still fsyncs the WAL on
    # every commit).
    if index is not None and to_probe:
        pairs: list[tuple[VideoEntry, float]] = []
        for slot in range(len(to_probe)):
            entry = probed[slot]
            mt = mtimes[slot]
            if entry is not None and mt is not None:
                pairs.append((entry, mt))
        await asyncio.to_thread(index.upsert_many, pairs)
        log.info("video scan: persisted %d row(s) to the index", len(pairs))

    # Combine reused + freshly probed in walk order. Build a map keyed
    # on path so we can emit in the same `paths`-sorted order.
    by_id: dict[str, VideoEntry] = {e.id: e for e in reused}
    for entry in probed:
        if entry is not None:
            by_id[entry.id] = entry
    results: list[VideoEntry] = []
    for path in paths:
        rel = path.relative_to(root)
        vid = _make_id(rel)
        entry = by_id.get(vid)
        if entry is not None:
            results.append(entry)

    # Prune cache rows whose ids no longer appear on disk.
    if index is not None:
        live_ids = {e.id for e in results}
        removed = await asyncio.to_thread(index.delete_missing, live_ids)
        if removed:
            log.info("video scan: pruned %d stale row(s) from the index", removed)

    tracker.finish()
    log.info(
        "video scan: complete (%d videos; %d probed, %d reused from cache)",
        len(results),
        total_to_probe,
        len(reused),
    )
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
        elif child.is_file() and not child.name.startswith(".") and child.suffix.lower() in VIDEO_EXTENSIONS:
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


def cache_stem(video_id: str) -> str:
    """Hash the id to a bounded-length on-disk path component.

    The video id (`<slug>-<8hex>`) embeds the full rel_path, which on
    deeply nested libraries blows past APFS's / ext4's 255-byte
    NAME_MAX when used as a filename or directory name directly. Every
    on-disk cache (posters/<id>.png, subs/<id>/embed-N.vtt,
    hls/<id>/seg-N.ts) routes its id through this helper so cache
    layout stays portable across filesystems. The id itself is kept
    in its readable form for URLs, DB rows, and log lines.

    32 hex chars of sha256 = 128 bits; collisions across any
    realistic library are astronomically unlikely.
    """
    return hashlib.sha256(video_id.encode("utf-8")).hexdigest()[:32]
