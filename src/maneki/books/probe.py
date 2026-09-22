"""Find the books in an inbox folder and read each file's length, tags and chapters.

ffprobe reads chapters from every container a book arrives in: m4b and m4a
chapter tracks, MP3 ID3 `CHAP` frames, and Ogg / FLAC `CHAPTERxx` comments.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from maneki.audio.metadata import SUPPORTED_AUDIO_EXTS
from maneki.books.models import Chapter, SourceBook, SourceFile
from maneki.ffmpeg import ffprobe_path

_DIGITS_RE = re.compile(r"(\d+)")
# How deep a dropped folder is followed looking for books. A collection of
# collections ("Top 100 Sci-Fi Books - 1-25" holding a folder per book) is two,
# and a disc folder inside one of those is the third.
_MAX_SHELF_DEPTH = 3
# A subfolder that names a disc of one recording rather than a book of its own.
_DISC_NAME_RE = re.compile(r"^(?:cd|disc|disk|part|side|vol(?:ume)?)[\s._-]*\d+$|^\d{1,2}$", re.I)
_TAG_KEYS = (
    "title",
    "album",
    "artist",
    "album_artist",
    "composer",
    "date",
    "genre",
    "comment",
    "description",
    "asin",
    "series",
    "series-part",
)


class ProbeError(RuntimeError):
    """ffprobe is missing, or could not read a file."""


def is_audio(path: Path) -> bool:
    """A supported audio file, not a dot-file such as an AppleDouble sidecar."""
    return path.is_file() and not path.name.startswith(".") and path.suffix.lower() in SUPPORTED_AUDIO_EXTS


def _is_disc_name(name: str) -> bool:
    """True for a folder that names a disc of one recording: `CD1`, `Disc 2`, `Part 3`."""
    return bool(_DISC_NAME_RE.match(name.strip()))


def natural_key(path: Path) -> list[object]:
    """Sort `Part 2` before `Part 10`, part by part along the path."""
    key: list[object] = []
    for part in path.parts:
        key.extend(int(chunk) if chunk.isdigit() else chunk.casefold() for chunk in _DIGITS_RE.split(part))
    return key


def discover(inbox: Path, *, max_depth: int = _MAX_SHELF_DEPTH) -> list[Path]:
    """Every book waiting in `inbox`, however the rip arranged them.

    A folder is one book when it holds audio of its own, or when its
    subfolders are the discs of one recording. A folder of folders is a
    collection ("Harry Potter 1-7", "Top 100 Sci-Fi Books"), so each one
    inside is looked at the same way, down to `max_depth`.

    Whether one folder's own files are one book or several is not a question
    its shape can answer, so that is decided after probing; see
    `maneki.books.pipeline.separate_books`.
    """
    found: list[Path] = []
    for child in sorted(inbox.iterdir(), key=natural_key):
        if child.name.startswith("."):
            continue
        if is_audio(child):
            found.append(child)
        elif child.is_dir():
            found.extend(_books_in(child, depth=max_depth))
    return found


def _books_in(folder: Path, *, depth: int) -> list[Path]:
    """The books inside one dropped folder."""
    direct = sorted((p for p in folder.iterdir() if is_audio(p)), key=natural_key)
    subdirs = [p for p in sorted(folder.iterdir(), key=natural_key) if p.is_dir() and not p.name.startswith(".")]

    if direct:
        # Files of its own. Whether they are one book or several is decided
        # once their lengths are known.
        return [folder]
    if not subdirs or depth <= 0:
        return [folder] if any(is_audio(p) for p in folder.rglob("*")) else []
    if all(_is_disc_name(p.name) for p in subdirs):
        # `CD1`, `CD2`: the discs of one recording, which `audio_files` walks in order.
        return [folder]
    found: list[Path] = []
    for subdir in subdirs:
        found.extend(_books_in(subdir, depth=depth - 1))
    return found


def audio_files(book: Path) -> list[Path]:
    """The book's audio in reading order: the file itself, or every audio file under the folder."""
    if book.is_file():
        return [book]
    return sorted((p for p in book.rglob("*") if is_audio(p)), key=lambda p: natural_key(p.relative_to(book)))


def load_book(book: Path) -> SourceBook:
    """Probe every audio file of one inbox book, in reading order."""
    return SourceBook(path=book, files=[probe_file(p) for p in audio_files(book)])


def probe_file(path: Path) -> SourceFile:
    """Read one file's duration, bit rate, container tags and embedded chapters."""
    ffprobe = ffprobe_path()
    if ffprobe is None:
        raise ProbeError("ffprobe not found; install ffmpeg or set MANEKI_FFPROBE")
    result = subprocess.run(  # noqa: S603 - args are constructed locally
        [ffprobe, "-v", "error", "-show_format", "-show_chapters", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ProbeError(f"ffprobe could not read {path.name}: {result.stderr.strip()}")
    data = json.loads(result.stdout or "{}")
    fmt = data.get("format", {})
    raw_tags = {str(k).lower(): str(v) for k, v in (fmt.get("tags") or {}).items()}
    bit_rate = fmt.get("bit_rate")
    return SourceFile(
        path=path,
        duration_s=float(fmt.get("duration") or 0.0),
        bit_rate=int(bit_rate) if bit_rate else None,
        chapters=_chapters(data.get("chapters") or []),
        tags={k: raw_tags[k] for k in _TAG_KEYS if raw_tags.get(k, "").strip()},
    )


def _chapters(raw: list[dict[str, object]]) -> list[Chapter]:
    chapters: list[Chapter] = []
    for index, entry in enumerate(raw, start=1):
        tags = entry.get("tags")
        title = str(tags.get("title", "")).strip() if isinstance(tags, dict) else ""
        chapters.append(
            Chapter(
                title=title or f"Chapter {index}",
                start_s=float(str(entry.get("start_time", 0))),
                end_s=float(str(entry.get("end_time", 0))),
            )
        )
    # ffprobe lists chapters in the order they are stored, which for ID3 need
    # not be the order they play in.
    return sorted(chapters, key=lambda c: c.start_s)
