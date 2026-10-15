"""The audiobook library: every book under `<root>/Audiobooks/`, persisted beside the music index.

A book is a folder holding audio: `Audiobooks/<Author>/<Title>/` as
`maneki books import` writes it, or a folder directly under `Audiobooks/`
for a book filed without an author. Everything about a book is read back
from its files (tags, chapters, length) plus its `cover.jpg`.

A folder under `Audiobooks/` holding a `.collection` file is a collection
instead: short recordings (a Blinkist library) kept apart from the books.
Every audio file in it is an item of its own, so each keeps its own place
and finished mark, and the first folder level under the collection is the
item's group: `Audiobooks/Blinkist/Science/<Author> - <Title>.m4a`.

Rows live in the served root's `.maneki/index.db` in their own `books`
table with namespaced meta keys, the way the video index shares the file.
A rescan stats every book's files and re-probes only the books whose
files changed, so a warm start costs one directory walk.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
import time
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

from maneki.books.models import Chapter, ChapterSource, SourceBook
from maneki.books.probe import ProbeError, audio_files, is_audio, natural_key, probe_file
from maneki.books.write import file_names, part_title
from maneki.library import BOOKS_DIR_NAME

log = logging.getLogger(__name__)

SCHEMA_VERSION: Final[int] = 1
_SCHEMA_VERSION_KEY: Final[str] = "books_schema_version"
_LIBRARY_ROOT_KEY: Final[str] = "books_library_root_abs"
_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
    id           TEXT PRIMARY KEY,
    rel_path     TEXT NOT NULL UNIQUE,
    -- Size and mtime of every file of the book: unchanged means the row is reused.
    fingerprint  TEXT NOT NULL,
    data_json    TEXT NOT NULL
);
"""
COVER_NAME: Final[str] = "cover.jpg"
# The file that makes a folder under `Audiobooks/` a collection rather than an author.
COLLECTION_MARKER: Final[str] = ".collection"


class LibraryBookFile(BaseModel):
    """One audio file of a library book, placed on the book's timeline."""

    model_config = ConfigDict(frozen=True)

    rel_path: str  # relative to the Audiobooks folder
    duration_s: float
    offset_s: float
    size_bytes: int


class LibraryBook(BaseModel):
    """One book in the library, as its files describe it."""

    model_config = ConfigDict(frozen=True)

    id: str
    rel_path: str  # the book's folder, relative to the Audiobooks folder
    title: str
    author: str
    narrator: str | None = None
    year: str | None = None
    description: str | None = None
    asin: str | None = None
    series: str | None = None
    series_position: str | None = None
    duration_s: float
    files: list[LibraryBookFile]
    chapters: list[Chapter]
    chapter_source: ChapterSource
    has_cover: bool
    # Set for an item of a collection: the collection's folder name, and its group (the folder
    # under the collection it sits in, or None when it sits in the collection itself).
    collection: str | None = None
    group: str | None = None
    # Where the cover lives, relative to the Audiobooks folder. A book's is its folder's
    # `cover.jpg`; an item takes its group's, else its collection's.
    cover_rel: str | None = None


def books_dir(root: Path) -> Path | None:
    """The served root's top-level Audiobooks folder, matched in any case, or None."""
    try:
        children = list(root.iterdir())
    except OSError:
        return None
    return next((c for c in children if c.is_dir() and c.name.casefold() == BOOKS_DIR_NAME), None)


def file_chapters(book: SourceBook) -> tuple[list[Chapter], ChapterSource]:
    """Chapters the files already carry, or one per file for a multi-file book."""
    if len(book.files) == 1:
        embedded = book.files[0].chapters
        return (embedded, ChapterSource.FILE) if len(embedded) >= 2 else ([], ChapterSource.NONE)
    chapters: list[Chapter] = []
    offset = 0.0
    embedded_any = any(f.chapters for f in book.files)
    names = file_names("", [f.path for f in book.files])
    for source, name in zip(book.files, names, strict=True):
        if embedded_any and source.chapters:
            chapters.extend(
                Chapter(title=c.title, start_s=offset + c.start_s, end_s=offset + c.end_s) for c in source.chapters
            )
        else:
            chapters.append(Chapter(title=part_title(name), start_s=offset, end_s=offset + source.duration_s))
        offset += source.duration_s
    return chapters, ChapterSource.FILE if embedded_any else ChapterSource.FILES


def book_id(rel_path: str) -> str:
    """A stable id for the book folder at `rel_path`; it changes only if the folder moves."""
    return hashlib.sha1(f"book:{rel_path}".encode()).hexdigest()[:16]


def is_collection(folder: Path) -> bool:
    """True for a folder marked as a collection."""
    return (folder / COLLECTION_MARKER).is_file()


def find_book_dirs(books_root: Path) -> list[Path]:
    """Every book folder: `<Author>/<Title>/` holding audio, or a top folder holding audio itself."""
    found: list[Path] = []
    for top in _visible_dirs(books_root):
        if is_collection(top):
            continue
        if any(is_audio(p) for p in top.iterdir()):
            found.append(top)
            continue
        found.extend(d for d in _visible_dirs(top) if any(is_audio(p) for p in d.rglob("*")))
    return sorted(found, key=lambda p: natural_key(p.relative_to(books_root)))


def find_collection_items(books_root: Path) -> list[Path]:
    """Every audio file of every collection, each one an item."""
    found: list[Path] = []
    for top in _visible_dirs(books_root):
        if is_collection(top):
            found.extend(p for p in top.rglob("*") if is_audio(p) and not _hidden(p.relative_to(top)))
    return sorted(found, key=lambda p: natural_key(p.relative_to(books_root)))


def read_item(books_root: Path, path: Path) -> LibraryBook:
    """Probe one collection file into a `LibraryBook` of its own.

    The tags name it when they can; a file named `<Author> - <Title>` names
    it otherwise, the way a Blinkist rip is laid out.
    """
    source = probe_file(path)
    rel = path.relative_to(books_root)
    collection = rel.parts[0]
    group = rel.parts[1] if len(rel.parts) > 2 else None
    named_author, _, named_title = path.stem.partition(" - ")
    if not named_title:
        named_author, named_title = "", path.stem
    tags = source.tags
    chapters, chapter_source = file_chapters(SourceBook(path=path, files=[source]))
    cover_rel = next(
        (
            c
            for c in ([f"{collection}/{group}/{COVER_NAME}"] if group else []) + [f"{collection}/{COVER_NAME}"]
            if (books_root / c).is_file()
        ),
        None,
    )
    return LibraryBook(
        id=book_id(rel.as_posix()),
        rel_path=rel.as_posix(),
        title=(tags.get("title") or "").strip() or named_title.strip(),
        author=(tags.get("artist") or tags.get("album_artist") or "").strip() or named_author.strip() or collection,
        narrator=(tags.get("composer") or "").strip() or None,
        year=_year(tags.get("date")),
        description=(tags.get("description") or tags.get("comment") or "").strip() or None,
        duration_s=source.duration_s,
        files=[
            LibraryBookFile(
                rel_path=rel.as_posix(), duration_s=source.duration_s, offset_s=0.0, size_bytes=path.stat().st_size
            )
        ],
        chapters=chapters,
        chapter_source=chapter_source,
        has_cover=cover_rel is not None,
        collection=collection,
        group=group,
        cover_rel=cover_rel,
    )


def read_book(books_root: Path, folder: Path) -> LibraryBook:
    """Probe one book folder into a `LibraryBook`."""
    probed = [probe_file(p) for p in audio_files(folder)]
    rel = folder.relative_to(books_root).as_posix()
    tags = [f.tags for f in probed]
    author_dir = folder.parent.name if folder.parent != books_root else None
    files: list[LibraryBookFile] = []
    offset = 0.0
    for source in probed:
        files.append(
            LibraryBookFile(
                rel_path=source.path.relative_to(books_root).as_posix(),
                duration_s=source.duration_s,
                offset_s=offset,
                size_bytes=source.path.stat().st_size,
            )
        )
        offset += source.duration_s
    chapters, chapter_source = file_chapters(SourceBook(path=folder, files=probed))
    return LibraryBook(
        id=book_id(rel),
        rel_path=rel,
        title=majority(t.get("album") for t in tags) or folder.name,
        author=majority(t.get("album_artist") or t.get("artist") for t in tags) or author_dir or "Unknown Author",
        narrator=majority(t.get("composer") for t in tags),
        year=_year(majority(t.get("date") for t in tags)),
        description=majority(t.get("description") or t.get("comment") for t in tags),
        asin=majority(t.get("asin") for t in tags),
        series=majority(t.get("series") for t in tags),
        series_position=majority(t.get("series-part") for t in tags),
        duration_s=offset,
        files=files,
        chapters=chapters,
        chapter_source=chapter_source,
        has_cover=(folder / COVER_NAME).is_file(),
        cover_rel=f"{rel}/{COVER_NAME}",
    )


class BooksIndex:
    """The books under one served root, kept in memory and in `.maneki/index.db`.

    `rescan()` is safe to call from any thread; readers see the previous
    list until a rescan finishes and swaps in the new one.
    """

    def __init__(self, root: Path, *, use_cache: bool = True) -> None:
        self._added: dict[str, float] = {}
        self.library_root = root
        self.root = books_dir(root) or root / "Audiobooks"
        self._use_cache = use_cache
        self._books: dict[str, LibraryBook] = {}
        self._lock = threading.Lock()
        self.scan_in_progress = False

    def added(self, book: LibraryBook) -> float:
        """When a book came into the library, as nearly as the disk says: its folder's time.

        Nothing records the moment, and every book said 1970. Read once per folder and kept.
        """
        held = self._added.get(book.rel_path)
        if held is None:
            try:
                held = (self.root / book.rel_path).stat().st_mtime
            except OSError:
                # Not kept: a folder unreadable now (the drive away) is read again next time.
                return 0.0
            self._added[book.rel_path] = held
        return held

    @property
    def books(self) -> list[LibraryBook]:
        """Every book and every collection item, by author then title."""
        return sorted(self._books.values(), key=lambda b: (b.author.casefold(), b.title.casefold()))

    @property
    def shelf(self) -> list[LibraryBook]:
        """The books alone, without the items of any collection."""
        return [b for b in self.books if b.collection is None]

    def collections(self) -> list[str]:
        """The names of the collections that hold anything, by name."""
        return sorted({b.collection for b in self._books.values() if b.collection}, key=str.casefold)

    def items(self, collection: str, group: str | None = None) -> list[LibraryBook]:
        """One collection's items, or one group's, by title."""
        return sorted(
            (b for b in self._books.values() if b.collection == collection and (group is None or b.group == group)),
            key=lambda b: b.title.casefold(),
        )

    def groups(self, collection: str) -> list[str]:
        """The groups of one collection, by name. Items outside any group are not one."""
        return sorted(
            {b.group for b in self._books.values() if b.collection == collection and b.group}, key=str.casefold
        )

    def cover_path(self, book: LibraryBook) -> Path | None:
        """The book's cover file on disk, or None."""
        if not book.has_cover:
            return None
        # Rows indexed before `cover_rel` existed are books, whose cover is their folder's.
        path = self.root / (book.cover_rel or f"{book.rel_path}/{COVER_NAME}")
        return path if path.is_file() else None

    def get(self, book_id: str) -> LibraryBook | None:
        return self._books.get(book_id)

    def file_path(self, rel_path: str) -> Path:
        """The absolute path of a book file or cover given relative to the Audiobooks folder."""
        return self.root / rel_path

    def rescan(self) -> None:
        """Walk the books folder and re-probe only the books whose files changed."""
        with self._lock:
            if self.scan_in_progress:
                return
            self.scan_in_progress = True
        try:
            self._books = self._scan()
        finally:
            with self._lock:
                self.scan_in_progress = False

    def start_background_rescan(self, *, force: bool = False) -> bool:
        """Rescan on a daemon thread. Returns False when one is already running."""
        with self._lock:
            if self.scan_in_progress:
                return False
        threading.Thread(target=self.rescan, name="maneki-books-rescan", daemon=True).start()
        return True

    def _scan(self) -> dict[str, LibraryBook]:
        started = time.monotonic()
        folders = find_book_dirs(self.root) if self.root.is_dir() else []
        items = find_collection_items(self.root) if self.root.is_dir() else []
        conn = self._open()
        cached: dict[str, tuple[str, str]] = {}
        if conn is not None:
            cached = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT rel_path, fingerprint, data_json FROM books")}
        books: dict[str, LibraryBook] = {}
        probed = 0
        for folder in [*folders, *items]:
            rel = folder.relative_to(self.root).as_posix()
            fingerprint = _fingerprint(folder)
            hit = cached.get(rel)
            if hit is not None and hit[0] == fingerprint:
                book = LibraryBook.model_validate_json(hit[1])
            else:
                try:
                    book = read_item(self.root, folder) if folder.is_file() else read_book(self.root, folder)
                except (ProbeError, OSError) as exc:
                    log.warning("books: skipping %s: %s", rel, exc)
                    continue
                probed += 1
                if conn is not None:
                    conn.execute(
                        "INSERT OR REPLACE INTO books(id, rel_path, fingerprint, data_json) VALUES (?, ?, ?, ?)",
                        (book.id, rel, fingerprint, book.model_dump_json()),
                    )
            books[book.id] = book
        if conn is not None:
            live = {b.rel_path for b in books.values()}
            conn.executemany("DELETE FROM books WHERE rel_path = ?", [(r,) for r in cached if r not in live])
            conn.commit()
            conn.close()
        log.info("books: %d books (%d probed) in %.1fs", len(books), probed, time.monotonic() - started)
        return books

    def _open(self) -> sqlite3.Connection | None:
        if not self._use_cache:
            return None
        cache_dir = self.library_root / ".maneki"
        try:
            cache_dir.mkdir(exist_ok=True)
            conn = sqlite3.connect(cache_dir / "index.db", timeout=10)
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(_SCHEMA)
            meta = dict(conn.execute("SELECT key, value FROM meta WHERE key IN (?, ?)", _META_KEYS).fetchall())
            root_abs = str(self.root.resolve())
            if meta.get(_SCHEMA_VERSION_KEY) != str(SCHEMA_VERSION) or meta.get(_LIBRARY_ROOT_KEY) != root_abs:
                conn.execute("DELETE FROM books")
                conn.executemany(
                    "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                    [(_SCHEMA_VERSION_KEY, str(SCHEMA_VERSION)), (_LIBRARY_ROOT_KEY, root_abs)],
                )
                conn.commit()
            return conn
        except (OSError, sqlite3.Error) as exc:
            log.warning("books: index cache disabled (%s); scanning in memory", exc)
            return None


_META_KEYS: Final[tuple[str, str]] = (_SCHEMA_VERSION_KEY, _LIBRARY_ROOT_KEY)


def _fingerprint(folder: Path) -> str:
    # An item's cover is its group's or its collection's, so a cover added there is seen too.
    item = folder.is_file()
    covers = [folder.parent / COVER_NAME, folder.parent.parent / COVER_NAME] if item else [folder / COVER_NAME]
    entries = []
    for path in [*audio_files(folder), *covers]:
        try:
            stat = path.stat()
        except OSError:
            continue
        name = path.as_posix() if item else path.relative_to(folder).as_posix()
        entries.append((name, stat.st_size, round(stat.st_mtime, 3)))
    return json.dumps(entries)


def _hidden(rel: Path) -> bool:
    return any(part.startswith(".") for part in rel.parts)


def _visible_dirs(parent: Path) -> list[Path]:
    try:
        return [c for c in parent.iterdir() if c.is_dir() and not c.name.startswith(".")]
    except OSError:
        return []


def majority(values: Iterable[str | None]) -> str | None:
    """The most common non-blank value, or None."""
    counts = Counter(v.strip() for v in values if v and v.strip())
    return counts.most_common(1)[0][0] if counts else None


def _year(date: str | None) -> str | None:
    return date[:4] if date and date[:4].isdigit() else None
