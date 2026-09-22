"""Value types shared by the book probe, the catalog lookup and the import."""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, ConfigDict


class Chapter(BaseModel):
    """One chapter, as offsets into the book's timeline in seconds."""

    model_config = ConfigDict(frozen=True)

    title: str
    start_s: float
    end_s: float


class ChapterSource(StrEnum):
    """Where a book's chapters came from, best first."""

    FILE = "file"  # embedded in the audio (m4b chapters, ID3 CHAP, Vorbis CHAPTERxx)
    CATALOG = "catalog"  # Audible's list, used only when the runtime matches this recording
    FILES = "files"  # a multi-file book, one chapter per file
    NONE = "none"


class SourceFile(BaseModel):
    """One audio file of a source book, as ffprobe sees it."""

    model_config = ConfigDict(frozen=True)

    path: Path
    duration_s: float
    bit_rate: int | None = None
    chapters: list[Chapter] = []
    # Lower-cased container tags: title, album, artist, album_artist, composer, date, genre.
    tags: dict[str, str] = {}


class SourceBook(BaseModel):
    """A book waiting in the inbox: one folder, or one loose audio file."""

    model_config = ConfigDict(frozen=True)

    path: Path
    files: list[SourceFile]

    @property
    def duration_s(self) -> float:
        return sum(f.duration_s for f in self.files)

    @property
    def name(self) -> str:
        return self.path.stem if self.path.is_file() else self.path.name


class NameGuess(BaseModel):
    """What a book's file or folder name suggests before any lookup.

    `author` and `title` may be swapped: rips name books both
    `Author - Title` and `Title - Author`. `terms` is the cleaned name for a
    catalog keyword search, which settles the order.
    """

    model_config = ConfigDict(frozen=True)

    terms: str
    title: str | None = None
    author: str | None = None
    narrator: str | None = None
    year: str | None = None


class CatalogBook(BaseModel):
    """One edition as a catalog lists it."""

    model_config = ConfigDict(frozen=True)

    source: str  # "audible" or "itunes"
    title: str
    authors: list[str]
    asin: str | None = None
    subtitle: str | None = None
    narrators: list[str] = []
    year: str | None = None
    runtime_s: float | None = None
    cover_url: str | None = None
    description: str | None = None
    series: str | None = None
    series_position: str | None = None
    language: str | None = None


class CatalogChapters(BaseModel):
    """An edition's chapter list with the runtime it was measured against.

    Audible releases open with a few seconds of branding ("This is Audible")
    and close with a few more; rips often drop them, which shifts every
    chapter. `intro_s` and `outro_s` let the alignment account for that.
    """

    model_config = ConfigDict(frozen=True)

    runtime_s: float
    chapters: list[Chapter]
    intro_s: float = 0.0
    outro_s: float = 0.0
