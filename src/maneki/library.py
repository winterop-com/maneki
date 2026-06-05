"""Cross-cutting library scan that summarises both audio and video under one root.

`maneki library [root]` calls into here. Maneki treats a library as a
single directory — the same root is scanned for both audio and video files
(by extension). There is no `audio/`/`videos/` subdirectory convention;
users point at one directory and the scanner finds what's there at any
depth.

The shape stays small for the base layer: count audio + video files under
one root. Richer indexing (SQLite cache, audit, fix, retag) stays under
the kind-specific subgroups (`maneki audio library`, etc).
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from maneki.audio.metadata import SUPPORTED_AUDIO_EXTS

# Single source of truth - reuse the Subsonic-side audio extension set
# directly. Drifting these apart caused a subtle bug where has_audio()
# would return True on a .wma-only library (was previously listed here
# but not in SUPPORTED_AUDIO_EXTS), the audio mount was created, and
# then the Subsonic library scan found zero tracks.
AUDIO_EXTENSIONS = SUPPORTED_AUDIO_EXTS

# Directory names we never descend into. Mirrors the video scanner's
# skip list so summarise / scan_files don't walk the server's own
# caches or git internals.
_SCAN_SKIP_DIR_NAMES = frozenset({".maneki", ".musickit", ".git", "__pycache__"})


def _is_hidden(name: str) -> bool:
    """True for dotfiles, which includes macOS AppleDouble sidecars (`._foo.mp3`).

    AppleDouble files share the real file's extension, so a plain suffix
    check treats `._track.mkv` as a real video and the indexer / ffprobe
    chokes on the 4 KB resource-fork stub. Skipping every dot-prefixed name
    drops those plus `.DS_Store` and friends; real media is never named
    with a leading dot. Mirrors the audio discover walk's convention.
    """
    return name.startswith(".")


class LibrarySummary(BaseModel):
    """A counted summary of one library root."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    root: Path
    audio_count: int
    video_count: int

    @property
    def is_empty(self) -> bool:
        """True if neither audio nor video content was found."""
        return self.audio_count == 0 and self.video_count == 0


class FileEntry(BaseModel):
    """One file found during a scan."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    rel_path: Path
    size_bytes: int
    kind: str  # "audio" or "video"


class ScanResult(BaseModel):
    """Full file inventory for one library root."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    root: Path
    audio: list[FileEntry]
    video: list[FileEntry]


def _iter_files(root: Path, extensions: frozenset[str]) -> Iterator[Path]:
    """Yield every file under root whose suffix is in `extensions`.

    Skips cache / VCS directories so a library walk never trips into
    `.maneki/` (server-managed cache) or `.git/`.
    """
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
            elif child.is_file() and not _is_hidden(child.name) and child.suffix.lower() in extensions:
                yield child


def _count(root: Path, extensions: frozenset[str]) -> int:
    return sum(1 for _ in _iter_files(root, extensions))


def has_audio(root: Path) -> bool:
    """True if there is at least one audio file anywhere under root."""
    return next(_iter_files(root, AUDIO_EXTENSIONS), None) is not None


def has_video(root: Path) -> bool:
    """True if there is at least one video file anywhere under root."""
    from maneki.video.serve.scan import VIDEO_EXTENSIONS

    return next(_iter_files(root, VIDEO_EXTENSIONS), None) is not None


def summarize(root: Path) -> LibrarySummary:
    """Scan a single library root and return per-kind file counts."""
    from maneki.video.serve.scan import VIDEO_EXTENSIONS

    return LibrarySummary(
        root=root,
        audio_count=_count(root, AUDIO_EXTENSIONS),
        video_count=_count(root, VIDEO_EXTENSIONS),
    )


def summarize_many(roots: Iterable[Path]) -> list[LibrarySummary]:
    """Summarize a list of library roots."""
    return [summarize(r) for r in roots]


def scan_files(root: Path) -> ScanResult:
    """Walk both kinds under root and return one entry per discovered file.

    Cheap: filesystem stat only, no ffprobe / no Mutagen / no DB write. Use this
    for an inventory dump. Persistent indexing (SQLite cache) is a later layer.
    """
    from maneki.video.serve.scan import VIDEO_EXTENSIONS

    return ScanResult(
        root=root,
        audio=_walk(root, AUDIO_EXTENSIONS, kind="audio"),
        video=_walk(root, VIDEO_EXTENSIONS, kind="video"),
    )


def scan_many(roots: Iterable[Path]) -> list[ScanResult]:
    """Scan a list of library roots."""
    return [scan_files(r) for r in roots]


def _walk(root: Path, extensions: frozenset[str], kind: str) -> list[FileEntry]:
    out: list[FileEntry] = []
    for path in sorted(_iter_files(root, extensions)):
        out.append(
            FileEntry(
                rel_path=path.relative_to(root),
                size_bytes=path.stat().st_size,
                kind=kind,
            )
        )
    return out
