"""Write an identified book into the library: copy the audio, then tag it.

The audio is copied byte for byte and only its tags change, so the
recording itself is never re-encoded:

- **MP3**: a fresh ID3v2.4 tag with the book's fields, the cover, and the
  chapters as `CHAP` / `CTOC` frames, which ffprobe and podcast and
  audiobook players read.
- **M4B / M4A**: iTunes atoms with media kind "audiobook". Chapters already
  in the file are kept; mutagen cannot write new ones, so catalog chapters
  are reported and not written.
- **FLAC / Ogg / Opus**: Vorbis comments, chapters as `CHAPTERxxx` pairs.
- Anything else is copied as is.

Tag conventions follow Audiobookshelf's reader: author in artist and album
artist, narrator in composer, the book title in album, `ASIN` as a
free-form field.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.id3 import (
    APIC,
    CHAP,
    COMM,
    CTOC,
    TALB,
    TCOM,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TRCK,
    TSSE,
    TXXX,
    CTOCFlags,
    ID3NoHeaderError,
)
from mutagen.id3 import ID3 as ID3Tags
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from pydantic import BaseModel, ConfigDict

from maneki import __version__
from maneki.audio.naming import sanitize_component
from maneki.books.models import Chapter

GENRE = "Audiobook"
_LEADING_NUMBER_RE = re.compile(r"^\s*(?:(?:cd|disc|part|track)\s*)?\d+\s*[-._)\s]\s*", re.I)


class BookTags(BaseModel):
    """What gets written into every file of one book."""

    model_config = ConfigDict(frozen=True)

    title: str
    author: str
    narrator: str | None = None
    year: str | None = None
    description: str | None = None
    asin: str | None = None
    series: str | None = None
    series_position: str | None = None
    cover_jpeg: bytes | None = None


def book_dir(library: Path, author: str, title: str) -> Path:
    """`<library>/<Author>/<Title>/`, each part made safe as a path component."""
    return library / sanitize_component(author) / sanitize_component(title)


def file_names(title: str, sources: list[Path]) -> list[str]:
    """Output names: the book's title for a one-file book, `NN - part` for the rest."""
    if len(sources) == 1:
        return [sanitize_component(title) + sources[0].suffix.lower()]
    width = max(2, len(str(len(sources))))
    names = []
    for index, src in enumerate(sources, start=1):
        part = _strip_numbering(src.stem) or f"Part {index}"
        names.append(f"{index:0{width}d} - {sanitize_component(part)}{src.suffix.lower()}")
    return names


def part_title(name: str) -> str:
    """The part's title as written into its tags: the output name without number or extension."""
    stem = Path(name).stem
    return _strip_numbering(stem) or stem


def _strip_numbering(stem: str) -> str:
    """A part's name without the rip's leading number: `02 Chapter Two` is `Chapter Two`, `03` is empty."""
    if stem.strip().isdigit():
        return ""
    return _LEADING_NUMBER_RE.sub("", stem).strip(" -_.")


def write_book(dest: Path, sources: list[Path], tags: BookTags, chapters: list[Chapter]) -> list[Path]:
    """Copy `sources` into `dest` and tag them. `chapters` go into a one-file book.

    Returns the written paths. Leaves nothing half-written: on failure the
    new folder is removed before the error propagates.
    """
    created = not dest.exists()
    dest.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    try:
        names = file_names(tags.title, sources)
        for index, (src, name) in enumerate(zip(sources, names, strict=True), start=1):
            out = dest / name
            shutil.copyfile(src, out)
            part = tags.title if len(sources) == 1 else part_title(name)
            file_chapters = chapters if len(sources) == 1 else []
            _tag(out, tags, part=part, track=(index, len(sources)), chapters=file_chapters)
            written.append(out)
        if tags.cover_jpeg:
            (dest / "cover.jpg").write_bytes(tags.cover_jpeg)
    except Exception:
        if created:
            shutil.rmtree(dest, ignore_errors=True)
        else:
            for path in written:
                path.unlink(missing_ok=True)
        raise
    return written


def writes_chapters(path: Path) -> bool:
    """True when `write_book` can put new chapters into a file of this kind."""
    return path.suffix.lower() in {".mp3", ".flac", ".ogg", ".oga", ".opus"}


def _tag(path: Path, tags: BookTags, *, part: str, track: tuple[int, int], chapters: list[Chapter]) -> None:
    suffix = path.suffix.lower()
    if suffix == ".mp3":
        _tag_mp3(path, tags, part=part, track=track, chapters=chapters)
    elif suffix in {".m4b", ".m4a", ".mp4"}:
        _tag_mp4(path, tags, part=part, track=track)
    elif suffix in {".flac", ".ogg", ".oga", ".opus"}:
        _tag_vorbis(path, tags, part=part, track=track, chapters=chapters)


def _tag_mp3(path: Path, tags: BookTags, *, part: str, track: tuple[int, int], chapters: list[Chapter]) -> None:
    id3 = ID3Tags()
    id3.add(TIT2(encoding=3, text=part))
    id3.add(TALB(encoding=3, text=tags.title))
    id3.add(TPE1(encoding=3, text=tags.author))
    id3.add(TPE2(encoding=3, text=tags.author))
    if tags.narrator:
        id3.add(TCOM(encoding=3, text=tags.narrator))
    id3.add(TCON(encoding=3, text=GENRE))
    if tags.year:
        id3.add(TDRC(encoding=3, text=tags.year))
    if track[1] > 1:
        id3.add(TRCK(encoding=3, text=f"{track[0]}/{track[1]}"))
    if tags.description:
        id3.add(COMM(encoding=3, lang="eng", desc="", text=tags.description))
    for desc, value in (("ASIN", tags.asin), ("SERIES", tags.series), ("SERIES-PART", tags.series_position)):
        if value:
            id3.add(TXXX(encoding=3, desc=desc, text=value))
    if tags.cover_jpeg:
        id3.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Front cover", data=tags.cover_jpeg))
    if chapters:
        ids = [f"ch{i:03d}" for i in range(len(chapters))]
        id3.add(
            CTOC(
                element_id="toc",
                flags=CTOCFlags.TOP_LEVEL | CTOCFlags.ORDERED,
                child_element_ids=ids,
                sub_frames=[TIT2(encoding=3, text="Chapters")],
            )
        )
        for element_id, chapter in zip(ids, chapters, strict=True):
            id3.add(
                CHAP(
                    element_id=element_id,
                    start_time=round(chapter.start_s * 1000),
                    end_time=round(chapter.end_s * 1000),
                    sub_frames=[TIT2(encoding=3, text=chapter.title)],
                )
            )
    id3.add(TSSE(encoding=3, text=f"maneki {__version__}"))
    # Replaces whatever tag the rip carried (v1 and v2); the audio frames are untouched.
    try:
        ID3Tags(path).delete()
    except ID3NoHeaderError:
        pass
    id3.save(path, v2_version=4)


def _tag_mp4(path: Path, tags: BookTags, *, part: str, track: tuple[int, int]) -> None:
    mp4 = MP4(path)
    # `delete()` clears the file's tags but leaves the tag object in place, and
    # `add_tags()` refuses when one already exists — which is every m4b that
    # arrived tagged. Add one only when the file truly has none.
    mp4.delete()
    if mp4.tags is None:
        mp4.add_tags()
    atoms = mp4.tags
    assert atoms is not None
    atoms.clear()
    atoms["\xa9nam"] = [part]
    atoms["\xa9alb"] = [tags.title]
    atoms["\xa9ART"] = [tags.author]
    atoms["aART"] = [tags.author]
    if tags.narrator:
        atoms["\xa9wrt"] = [tags.narrator]
    atoms["\xa9gen"] = [GENRE]
    atoms["stik"] = [2]  # iTunes media kind: audiobook
    if tags.year:
        atoms["\xa9day"] = [tags.year]
    if track[1] > 1:
        atoms["trkn"] = [track]
    if tags.description:
        atoms["desc"] = [tags.description[:255]]
        atoms["ldes"] = [tags.description]
    if tags.asin:
        atoms["----:com.apple.iTunes:ASIN"] = [MP4FreeForm(tags.asin.encode())]
    if tags.cover_jpeg:
        atoms["covr"] = [MP4Cover(tags.cover_jpeg, imageformat=MP4Cover.FORMAT_JPEG)]
    atoms["\xa9too"] = [f"maneki {__version__}"]
    mp4.save()


def _tag_vorbis(path: Path, tags: BookTags, *, part: str, track: tuple[int, int], chapters: list[Chapter]) -> None:
    suffix = path.suffix.lower()
    audio: FLAC | OggVorbis | OggOpus
    if suffix == ".flac":
        audio = FLAC(path)
    elif suffix == ".opus":
        audio = OggOpus(path)
    else:
        audio = OggVorbis(path)
    audio.delete()
    comments: dict[str, str | None] = {
        "title": part,
        "album": tags.title,
        "artist": tags.author,
        "albumartist": tags.author,
        "composer": tags.narrator,
        "genre": GENRE,
        "date": tags.year,
        "description": tags.description,
        "asin": tags.asin,
        "tracknumber": f"{track[0]}/{track[1]}" if track[1] > 1 else None,
    }
    for index, chapter in enumerate(chapters, start=1):
        comments[f"CHAPTER{index:03d}"] = _vorbis_time(chapter.start_s)
        comments[f"CHAPTER{index:03d}NAME"] = chapter.title
    for key, value in comments.items():
        if value:
            audio[key] = value
    audio.save()


def _vorbis_time(seconds: float) -> str:
    millis = round(seconds * 1000)
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"
