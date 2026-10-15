"""Audiobooks as Subsonic content, so phone clients can browse and play them.

Books live in their own music folder (`Audiobooks`), which is how a client
is told to keep them apart from music: Symfonium and friends offer a folder
picker, and every browse endpoint honours `musicFolderId`. Within it, an
author reads as an artist, a book as an album, and a book's files as its
songs, typed `audiobook` so a client can treat them as spoken word.

A collection (see `maneki.books.library`) is a music folder of its own,
after the books: the collection reads as one artist, its groups as albums,
and its items as their songs, so a Blinkist library is one artist with a
few dozen albums rather than two thousand authors among the books.

Ids carry their own prefixes (`bka_`, `bkb_`, `bkt_`, `bkc_`, `bkg_`) so a
book can never be mistaken for an album that happens to hash the same way.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any, Final

from maneki.books.library import BooksIndex, LibraryBook
from maneki.books.write import part_title

# Subsonic music-folder ids. Music keeps 1, the id this server reported
# when it had one folder, so a client's saved settings keep working.
MUSIC_FOLDER_ID: Final[int] = 1
BOOKS_FOLDER_ID: Final[int] = 2
BOOKS_FOLDER_NAME: Final[str] = "Audiobooks"
# Collections take the folder ids after the books, in name order.
FIRST_COLLECTION_FOLDER_ID: Final[int] = 3

AUTHOR_PREFIX: Final[str] = "bka_"
BOOK_PREFIX: Final[str] = "bkb_"
FILE_PREFIX: Final[str] = "bkt_"
COLLECTION_PREFIX: Final[str] = "bkc_"
GROUP_PREFIX: Final[str] = "bkg_"
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
    return value.startswith((AUTHOR_PREFIX, BOOK_PREFIX, FILE_PREFIX, COLLECTION_PREFIX, GROUP_PREFIX))


def find_book(index: BooksIndex, value: str) -> LibraryBook | None:
    """The book a `bkb_` id names. A collection's item is not a book here: it is a song."""
    book = index.get(value[len(BOOK_PREFIX) :]) if value.startswith(BOOK_PREFIX) else None
    return book if book is not None and book.collection is None else None


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
    return next((b.author for b in index.shelf if author_id(b.author) == value), None)


def books_by(index: BooksIndex, author: str) -> list[LibraryBook]:
    """That author's books, by title."""
    return sorted((b for b in index.shelf if b.author == author), key=lambda b: b.title.casefold())


def authors(index: BooksIndex) -> list[str]:
    """Every author with a book, by name."""
    return sorted({b.author for b in index.shelf}, key=str.casefold)


# --- collections ---------------------------------------------------------------


def collection_folders(index: BooksIndex) -> list[tuple[int, str]]:
    """`(music folder id, collection name)` for every collection, in name order."""
    return [(FIRST_COLLECTION_FOLDER_ID + n, name) for n, name in enumerate(index.collections())]


def collection_id(collection: str) -> str:
    """`bkc_<sha1[:16] of the collection's name>`."""
    return COLLECTION_PREFIX + hashlib.sha1(f"collection:{collection}".encode()).hexdigest()[:16]


def group_id(collection: str, group: str | None) -> str:
    """`bkg_<sha1[:16] of collection and group>`. Items outside any group make a group of their own."""
    return GROUP_PREFIX + hashlib.sha1(f"group:{collection}/{group or ''}".encode()).hexdigest()[:16]


def group_name(collection: str, group: str | None) -> str:
    """What a group is called; the items outside any group take the collection's name."""
    return group or collection


def find_collection(index: BooksIndex, value: str) -> str | None:
    """The collection a `bkc_` id names."""
    if not value.startswith(COLLECTION_PREFIX):
        return None
    return next((c for c in index.collections() if collection_id(c) == value), None)


def find_group(index: BooksIndex, value: str) -> tuple[str, str | None] | None:
    """The collection and group a `bkg_` id names."""
    if not value.startswith(GROUP_PREFIX):
        return None
    for collection in index.collections():
        for group in [*index.groups(collection), None]:
            if group_id(collection, group) == value:
                return collection, group
    return None


def group_items(index: BooksIndex, collection: str, group: str | None) -> list[LibraryBook]:
    """A group's items by title, those outside any group when `group` is None."""
    return [b for b in index.items(collection) if b.group == group]


def collection_groups(index: BooksIndex, collection: str) -> list[str | None]:
    """The groups that hold anything, by name, with the ungrouped items last."""
    held: list[str | None] = [*index.groups(collection)]
    if any(b.group is None for b in index.items(collection)):
        held.append(None)
    return held


def collection_summary(index: BooksIndex, collection: str) -> dict[str, Any]:
    """Subsonic `artist` dict for a collection: its groups are its albums."""
    return {
        "id": collection_id(collection),
        "name": collection,
        "albumCount": len(collection_groups(index, collection)),
        "coverArt": collection_id(collection),
    }


def group_payload(
    index: BooksIndex,
    collection: str,
    group: str | None,
    *,
    with_songs: bool,
    positions: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Subsonic `album` dict for one group of a collection; its items are the songs, by title."""
    items = group_items(index, collection, group)
    gid = group_id(collection, group)
    payload: dict[str, Any] = {
        "id": gid,
        "name": group_name(collection, group),
        "artist": collection,
        "artistId": collection_id(collection),
        "songCount": len(items),
        "duration": int(sum(b.duration_s for b in items)),
        "coverArt": gid,
        "created": datetime.fromtimestamp(max((index.added(b) for b in items), default=0.0), tz=UTC).strftime(
            "%Y-%m-%dT%H:%M:%S.000Z"
        ),
        "genre": GENRE,
        "genres": [{"name": GENRE}],
        "isCompilation": True,
    }
    if with_songs:
        held = positions or {}
        payload["song"] = [
            {**file_payload(b, 0, position_s=held.get(b.id, 0.0)), "track": n} for n, b in enumerate(items, start=1)
        ]
    return payload


def author_summary(index: BooksIndex, author: str) -> dict[str, Any]:
    """Subsonic `artist` dict for an author."""
    written = books_by(index, author)
    return {
        "id": author_id(author),
        "name": author,
        "albumCount": len(written),
        "coverArt": book_subsonic_id(written[0]) if written else author_id(author),
    }


def book_payload(
    book: LibraryBook, *, with_songs: bool, position_s: float = 0.0, added_s: float = 0.0
) -> dict[str, Any]:
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
        "created": datetime.fromtimestamp(added_s, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
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
    # An item of a collection is a song on its group's album, by the collection.
    album_ref = book_subsonic_id(book) if book.collection is None else group_id(book.collection, book.group)
    payload: dict[str, Any] = {
        "id": file_id(book, index),
        "parent": album_ref,
        "isDir": False,
        "title": title,
        "album": book.title if book.collection is None else group_name(book.collection, book.group),
        "artist": book.author,
        "albumId": album_ref,
        "artistId": author_id(book.author) if book.collection is None else collection_id(book.collection),
        "coverArt": book_subsonic_id(book) if book.collection is None else album_ref,
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
