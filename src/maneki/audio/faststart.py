"""Put an MP4's index before its audio ("faststart"), byte for byte.

An `.m4a` is a run of boxes: `ftyp`, then `mdat` (the audio) and `moov` (the index: where every
chunk of audio sits, plus the tags and the cover). ffmpeg writes `moov` LAST unless asked not to,
and a player streaming such a file has to read the head, jump to the tail for the index, then
jump back before it can make a sound. Over a slow link that is several round trips per track,
which is what made switching tracks slow away from home.

Moving `moov` in front of `mdat` shifts the audio along by the size of `moov`, so every chunk
offset in the index (`stco`, 32-bit, or `co64`) gets that size added. Nothing else changes: the
audio, the tags and the cover are the same bytes, so the result is the file qt-faststart or
`ffmpeg -movflags +faststart` would write, without re-muxing anything that could lose a tag.

The rewrite goes to a temporary file beside the original, which replaces it only once complete.

THE FILE'S TIME MOVES, ITS FOLDER'S DOES NOT. The file gets a new modification time, so a sync by
size and time (`media-sync`) sees it changed and carries it; rsync sends only the part that moved.
The album folder's time is put back afterwards, because "Recently added" is sorted by it and a
rewrite is not an album arriving. The output depends only on the input.
"""

from __future__ import annotations

import os
import shutil
import struct
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import BinaryIO, Literal

from pydantic import BaseModel, ConfigDict

# The boxes on the way from `moov` down to the chunk-offset tables.
_CONTAINERS = frozenset({b"moov", b"trak", b"mdia", b"minf", b"stbl"})
_COPY_CHUNK = 1 << 20
MP4_SUFFIXES = frozenset({".m4a", ".m4b", ".mp4", ".aac"})

Outcome = Literal["converted", "already", "skipped"]


class FaststartError(ValueError):
    """The file cannot be rewritten as it stands; it is left alone."""


class _Box(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: bytes
    offset: int
    size: int


def _top_level(handle: BinaryIO, length: int) -> list[_Box]:
    boxes: list[_Box] = []
    offset = 0
    while offset < length:
        handle.seek(offset)
        head = handle.read(8)
        if len(head) < 8:
            raise FaststartError("truncated box header")
        size, kind = struct.unpack(">I4s", head)
        if size == 1:
            wide = handle.read(8)
            if len(wide) < 8:
                raise FaststartError("truncated 64-bit box size")
            size = struct.unpack(">Q", wide)[0]
        elif size == 0:
            size = length - offset
        if size < 8 or offset + size > length:
            raise FaststartError(f"bad size for box {kind!r}")
        boxes.append(_Box(kind=kind, offset=offset, size=size))
        offset += size
    return boxes


def _children(moov: bytearray, start: int, end: int) -> Iterator[tuple[bytes, int, int, int]]:
    """Each box between `start` and `end`: its kind, offset, header size and total size."""
    at = start
    while at + 8 <= end:
        size, kind = struct.unpack_from(">I4s", moov, at)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", moov, at + 8)[0]
            header = 16
        elif size == 0:
            size = end - at
        if size < header or at + size > end:
            raise FaststartError(f"bad size for box {kind!r} inside moov")
        yield kind, at, header, size
        at += size


def _shift_offsets(moov: bytearray, start: int, end: int, delta: int) -> None:
    for kind, at, header, size in _children(moov, start, end):
        if kind in _CONTAINERS:
            _shift_offsets(moov, at + header, at + size, delta)
        elif kind == b"stco":
            count = struct.unpack_from(">I", moov, at + header + 4)[0]
            table = at + header + 8
            for index in range(count):
                place = table + 4 * index
                moved = struct.unpack_from(">I", moov, place)[0] + delta
                if moved > 0xFFFFFFFF:
                    raise FaststartError("a 32-bit chunk offset would overflow")
                struct.pack_into(">I", moov, place, moved)
        elif kind == b"co64":
            count = struct.unpack_from(">I", moov, at + header + 4)[0]
            table = at + header + 8
            for index in range(count):
                place = table + 8 * index
                struct.pack_into(">Q", moov, place, struct.unpack_from(">Q", moov, place)[0] + delta)


def needs_faststart(path: Path) -> bool:
    """Whether the file's index comes after its audio. Raises `FaststartError` on a malformed file."""
    with path.open("rb") as handle:
        boxes = _top_level(handle, path.stat().st_size)
    kinds = [box.kind for box in boxes]
    if b"moov" not in kinds or b"mdat" not in kinds:
        raise FaststartError("no moov or no mdat: not an MP4 file")
    return kinds.index(b"moov") > kinds.index(b"mdat")


def faststart(path: Path, *, dry_run: bool = False) -> Outcome:
    """Move the index of one file to the front. `already` when it is there, `converted` when moved.

    A file that cannot be rewritten raises `FaststartError` and is not touched.
    """
    stat = path.stat()
    with path.open("rb") as handle:
        boxes = _top_level(handle, stat.st_size)
        kinds = [box.kind for box in boxes]
        if b"moov" not in kinds or b"mdat" not in kinds:
            raise FaststartError("no moov or no mdat: not an MP4 file")
        first_mdat = kinds.index(b"mdat")
        moov_box = boxes[kinds.index(b"moov")]
        if kinds.index(b"moov") < first_mdat:
            return "already"
        if kinds.count(b"moov") > 1:
            raise FaststartError("more than one moov")
        handle.seek(moov_box.offset)
        moov = bytearray(handle.read(moov_box.size))
        _, _, header, _ = next(_children(moov, 0, len(moov)))
        _shift_offsets(moov, header, len(moov), moov_box.size)
        if dry_run:
            return "converted"

        temporary = path.with_name(f".{path.name}.faststart.tmp")
        try:
            with temporary.open("wb") as out:
                ordered = [*boxes[:first_mdat], moov_box, *(b for b in boxes[first_mdat:] if b is not moov_box)]
                for box in ordered:
                    if box is moov_box:
                        out.write(moov)
                        continue
                    handle.seek(box.offset)
                    remaining = box.size
                    while remaining:
                        chunk = handle.read(min(_COPY_CHUNK, remaining))
                        if not chunk:
                            raise FaststartError("file shrank while it was being copied")
                        out.write(chunk)
                        remaining -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            shutil.copymode(path, temporary)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    os.replace(temporary, path)
    return "converted"


def iter_mp4_files(root: Path) -> Iterator[Path]:
    """Every MP4-family audio file under `root`, skipping maneki's own state and hidden files."""
    for directory, folders, files in os.walk(root):
        folders[:] = sorted(f for f in folders if not f.startswith("."))
        for name in sorted(files):
            if not name.startswith(".") and Path(name).suffix.lower() in MP4_SUFFIXES:
                yield Path(directory) / name


def faststart_library(
    root: Path,
    *,
    dry_run: bool = False,
    on_file: Callable[[Path, Outcome | FaststartError | OSError], None] | None = None,
) -> dict[Outcome, int]:
    """Faststart every MP4 file under `root`, folder by folder, keeping each folder's time.

    `on_file` hears each file and what happened to it: an outcome, or the error it was skipped for.
    """
    counts: dict[Outcome, int] = {"converted": 0, "already": 0, "skipped": 0}
    by_folder: dict[Path, list[Path]] = {}
    for path in iter_mp4_files(root):
        by_folder.setdefault(path.parent, []).append(path)
    for folder, paths in by_folder.items():
        held = folder.stat()
        rewrote = False
        try:
            for path in paths:
                result: Outcome | FaststartError | OSError
                try:
                    result = faststart(path, dry_run=dry_run)
                except (FaststartError, OSError) as error:
                    result = error
                outcome: Outcome = result if isinstance(result, str) else "skipped"
                counts[outcome] += 1
                rewrote = rewrote or (outcome == "converted" and not dry_run)
                if on_file is not None:
                    on_file(path, result)
        finally:
            if rewrote:
                os.utime(folder, ns=(held.st_atime_ns, held.st_mtime_ns))
    return counts
