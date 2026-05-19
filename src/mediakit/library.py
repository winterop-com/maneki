"""Cross-cutting library scan that summarises both audio and video under one root.

`mediakit library [root]` calls into here. The shape stays small for the
base layer: count audio + video files, report the subdir each was found in.
Richer indexing (SQLite cache, audit, fix, retag) stays under the
kind-specific subgroups (`mediakit audio library`, etc).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mediakit.video.serve.scan import find_videos_dir

AUDIO_EXTENSIONS = frozenset(
    {".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".opus", ".aac", ".wma", ".ape"}
)

AUDIO_DIR_CANDIDATES = ("audio", "music")


@dataclass(frozen=True)
class LibrarySummary:
    """A counted summary of one library root."""

    root: Path
    audio_dir: Path | None
    audio_count: int
    video_dir: Path | None
    video_count: int

    @property
    def is_empty(self) -> bool:
        """True if neither audio nor video content was found."""
        return self.audio_count == 0 and self.video_count == 0


def find_audio_dir(root: Path) -> Path | None:
    """Return the audio (or music) subdirectory under root, case-insensitive."""
    if not root.is_dir():
        return None
    for child in root.iterdir():
        if child.is_dir() and child.name.lower() in AUDIO_DIR_CANDIDATES:
            return child
    return None


def count_files_with_extensions(directory: Path, extensions: frozenset[str]) -> int:
    """Recursively count files under directory whose suffix is in extensions."""
    if not directory.is_dir():
        return 0
    return sum(1 for path in directory.rglob("*") if path.is_file() and path.suffix.lower() in extensions)


def summarize(root: Path) -> LibrarySummary:
    """Scan a single library root and return per-kind file counts."""
    audio_dir = find_audio_dir(root)
    video_dir = find_videos_dir(root)
    return LibrarySummary(
        root=root,
        audio_dir=audio_dir,
        audio_count=count_files_with_extensions(audio_dir, AUDIO_EXTENSIONS) if audio_dir else 0,
        video_dir=video_dir,
        video_count=_count_videos(video_dir) if video_dir else 0,
    )


def summarize_many(roots: list[Path]) -> list[LibrarySummary]:
    """Summarize a list of library roots."""
    return [summarize(r) for r in roots]


@dataclass(frozen=True)
class FileEntry:
    """One file found during a scan."""

    rel_path: Path
    size_bytes: int
    kind: str  # "audio" or "video"


@dataclass(frozen=True)
class ScanResult:
    """Full file inventory for one library root."""

    root: Path
    audio_dir: Path | None
    video_dir: Path | None
    audio: list[FileEntry]
    video: list[FileEntry]


def scan_files(root: Path) -> ScanResult:
    """Walk both kinds under root and return one entry per discovered file.

    Cheap: filesystem stat only, no ffprobe / no Mutagen / no DB write. Use this
    for an inventory dump. Persistent indexing (SQLite cache) is a later layer.
    """
    audio_dir = find_audio_dir(root)
    video_dir = find_videos_dir(root)
    audio_entries = _walk(audio_dir, AUDIO_EXTENSIONS, kind="audio") if audio_dir else []
    video_entries = _walk(video_dir, _video_extensions(), kind="video") if video_dir else []
    return ScanResult(
        root=root,
        audio_dir=audio_dir,
        video_dir=video_dir,
        audio=audio_entries,
        video=video_entries,
    )


def scan_many(roots: list[Path]) -> list[ScanResult]:
    """Scan a list of library roots."""
    return [scan_files(r) for r in roots]


def _walk(directory: Path, extensions: frozenset[str], kind: str) -> list[FileEntry]:
    out: list[FileEntry] = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.suffix.lower() in extensions:
            out.append(
                FileEntry(
                    rel_path=path.relative_to(directory),
                    size_bytes=path.stat().st_size,
                    kind=kind,
                )
            )
    return out


def _count_videos(directory: Path) -> int:
    return count_files_with_extensions(directory, _video_extensions())


def _video_extensions() -> frozenset[str]:
    from mediakit.video.serve.scan import VIDEO_EXTENSIONS

    return VIDEO_EXTENSIONS
