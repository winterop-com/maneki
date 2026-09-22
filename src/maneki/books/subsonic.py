"""Audiobooks as Subsonic content, so phone clients can browse and play them.

Books live in their own music folder (`Audiobooks`), which is how a client
is told to keep them apart from music: Symfonium and friends offer a folder
picker, and every browse endpoint honours `musicFolderId`. Within it, an
author reads as an artist, a book as an album, and a book's files as its
songs, typed `audiobook` so a client can treat them as spoken word.

Ids carry their own prefixes (`bka_`, `bkb_`, `bkt_`) so a book can never
be mistaken for an album that happens to hash the same way.
"""

from __future__ import annotations

import hashlib
from typing import Any, Final

from maneki.books.library import BooksIndex, LibraryBook
from maneki.books.write import part_title

# Subsonic music-folder ids. Music keeps 1, the id this server reported
# when it had one folder, so a client's saved settings keep working.
MUSIC_FOLDER_ID: Final[int] = 1
BOOKS_FOLDER_ID: Final[int] = 2
BOOKS_FOLDER_NAME: Final[str] = "Audiobooks"

AUTHOR_PREFIX: Final[str] = "bka_"
BOOK_PREFIX: Final[str] = "bkb_"
FILE_PREFIX: Final[str] = "bkt_"
GENRE: Final[str] = "Audiobook"

_CONTENT_TYPES: Final[dict[str, str]] = {
    ".mp3": "audio/mpeg",
    ".m4b": "audio/mp4",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
}


def author_id(author: str) -> str:
    """`bka_<sha1[:16] of the author's name>`."""
    return AUTHOR_PREFIX + hashlib.sha1(author.encode()).hexdigest()[:16]


def book_subsonic_id(book: LibraryBook) -> str:
    """`bkb_<the book's own id>`."""
    return BOOK_PREFIX + book.id


def file_id(book: LibraryBook, index: int) -> str:
    """`bkt_<book id>_<file number>`."""
    return f"{FILE_PREFIX}{book.id}_{index}"


def is_book_id(value: str) -> bool:
    """True for any id this module hands out."""
    return value.startswith((AUTHOR_PREFIX, BOOK_PREFIX, FILE_PREFIX))


def find_book(index: BooksIndex, value: str) -> LibraryBook | None:
    """The book a `bkb_` id names."""
    return index.get(value[len(BOOK_PREFIX) :]) if value.startswith(BOOK_PREFIX) else None


def find_file(index: BooksIndex, value: str) -> tuple[LibraryBook, int] | None:
    """The book and file number a `bkt_` id names, if both still exist."""
    if not value.startswith(FILE_PREFIX):
        return None
    book_id, _, number = value[len(FILE_PREFIX) :].rpartition("_")
    book = index.get(book_id)
    if book is None or not number.isdigit() or not 0 <= int(number) < len(book.files):
        return None
    return book, int(number)


def find_author(index: BooksIndex, value: str) -> str | None:
    """The author name a `bka_` id names."""
    if not value.startswith(AUTHOR_PREFIX):
        return None
    return next((b.author for b in index.books if author_id(b.author) == value), None)


def books_by(index: BooksIndex, author: str) -> list[LibraryBook]:
    """That author's books, by title."""
    return sorted((b for b in index.books if b.author == author), key=lambda b: b.title.casefold())


def authors(index: BooksIndex) -> list[str]:
    """Every author with a book, by name."""
    return sorted({b.author for b in index.books}, key=str.casefold)


def author_summary(index: BooksIndex, author: str) -> dict[str, Any]:
    """Subsonic `artist` dict for an author."""
    written = books_by(index, author)
    return {
        "id": author_id(author),
        "name": author,
        "albumCount": len(written),
        "coverArt": book_subsonic_id(written[0]) if written else author_id(author),
    }


def book_payload(book: LibraryBook, *, with_songs: bool, position_s: float = 0.0) -> dict[str, Any]:
    """Subsonic `album` dict for a book.

    `position_s` is where this account stopped, passed on to the songs so a
    client can offer to resume mid-book.
    """
    payload: dict[str, Any] = {
        "id": book_subsonic_id(book),
        "name": book.title,
        "artist": book.author,
        "artistId": author_id(book.author),
        "songCount": len(book.files),
        "duration": int(book.duration_s),
        "coverArt": book_subsonic_id(book),
        "created": "1970-01-01T00:00:00.000Z",
        "genre": GENRE,
        "genres": [{"name": GENRE}],
        "isCompilation": False,
    }
    if book.year and book.year.isdigit():
        payload["year"] = int(book.year)
    if with_songs:
        payload["song"] = [file_payload(book, i, position_s=position_s) for i in range(len(book.files))]
    return payload


def file_payload(book: LibraryBook, index: int, *, position_s: float = 0.0) -> dict[str, Any]:
    """Subsonic `song` dict for one file of a book.

    A single-file book takes the book's own title; the parts of a longer one
    take their file names. When the saved position falls inside this file,
    `bookmarkPosition` carries the offset into it, in milliseconds, which is
    what a client reads to resume.
    """
    entry = book.files[index]
    suffix = entry.rel_path.rsplit(".", 1)[-1].lower() if "." in entry.rel_path else ""
    title = book.title if len(book.files) == 1 else part_title(entry.rel_path.rsplit("/", 1)[-1])
    payload: dict[str, Any] = {
        "id": file_id(book, index),
        "parent": book_subsonic_id(book),
        "isDir": False,
        "title": title,
        "album": book.title,
        "artist": book.author,
        "albumId": book_subsonic_id(book),
        "artistId": author_id(book.author),
        "coverArt": book_subsonic_id(book),
        "duration": int(entry.duration_s),
        "size": entry.size_bytes,
        "suffix": suffix,
        "contentType": _CONTENT_TYPES.get(f".{suffix}", "application/octet-stream"),
        "path": entry.rel_path,
        "isVideo": False,
        # Subsonic's media kind: what tells a client this is spoken word.
        "type": "audiobook",
        "mediaType": "audiobook",
        "genre": GENRE,
        "genres": [{"name": GENRE}],
        "track": index + 1,
    }
    if book.year and book.year.isdigit():
        payload["year"] = int(book.year)
    offset_into_file = position_s - entry.offset_s
    if 0 < offset_into_file < entry.duration_s:
        payload["bookmarkPosition"] = int(offset_into_file * 1000)
    return payload


def file_of_position(book: LibraryBook, position_s: float) -> tuple[int, float]:
    """The file a book-wide position falls in, and the offset into it."""
    for index, entry in enumerate(book.files):
        if position_s < entry.offset_s + entry.duration_s:
            return index, max(0.0, position_s - entry.offset_s)
    last = len(book.files) - 1
    return last, book.files[last].duration_s if book.files else 0.0
