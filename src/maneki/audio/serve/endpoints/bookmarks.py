"""Subsonic bookmarks: a saved position inside a track, per account.

This is how a Subsonic client resumes a long recording. Symfonium, Amperfy
and play:Sub save one on pause and offer "resume" when the track is opened
again. Each bookmark carries the track it belongs to, so a client can show
a shelf of half-heard recordings without asking about each one.

A bookmark on an audiobook file is the book's own position seen through the
Subsonic grammar: it is stored once, in the book's progress store, so a
phone and the web app resume at the same place rather than each keeping
their own idea of where you stopped.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Query, Request

from maneki.audio.serve.app import envelope, error_envelope
from maneki.audio.serve.bookmarks import Bookmark, BookmarkStore
from maneki.audio.serve.index import IndexCache
from maneki.audio.serve.payloads import song_payload
from maneki.books.library import BooksIndex
from maneki.books.progress import ProgressStore
from maneki.books.subsonic import file_of_position, file_payload, find_file

router = APIRouter()


def _store(request: Request) -> BookmarkStore:
    return request.state.bookmarks  # type: ignore[no-any-return]


def _cache(request: Request) -> IndexCache:
    return request.app.state.cache  # type: ignore[no-any-return]


def _books(request: Request) -> BooksIndex | None:
    """The audiobook index, when this root has one."""
    return getattr(request.app.state, "books", None)


def _progress(request: Request) -> ProgressStore:
    return request.state.progress  # type: ignore[no-any-return]


def _book_bookmarks(request: Request, username: str) -> list[dict]:
    """This account's book positions, as Subsonic bookmarks on the file they fall in."""
    books = _books(request)
    if books is None:
        return []
    entries = []
    for saved in _progress(request).all():
        book = books.get(saved.book_id)
        if book is None or saved.position_s <= 0 or not book.files:
            continue
        number, offset_s = file_of_position(book, saved.position_s)
        entries.append(
            {
                "position": int(offset_s * 1000),
                "username": username,
                "comment": "",
                "created": _iso(saved.updated_at),
                "changed": _iso(saved.updated_at),
                "entry": file_payload(book, number, position_s=saved.position_s),
            }
        )
    return entries


def _iso(stamp: float) -> str:
    return datetime.fromtimestamp(stamp, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _payload(request: Request, bookmark: Bookmark, username: str) -> dict | None:
    """One `bookmark` entry, or None when its track has left the library."""
    found = _cache(request).tracks_by_id.get(bookmark.track_id)
    if found is None:
        return None
    album, track = found
    return {
        "position": bookmark.position_ms,
        "username": username,
        "comment": bookmark.comment,
        "created": _iso(bookmark.created_at),
        "changed": _iso(bookmark.changed_at),
        "entry": song_payload(album, track),
    }


@router.api_route("/getBookmarks", methods=["GET", "POST", "HEAD"])
@router.api_route("/getBookmarks.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_bookmarks(request: Request) -> dict:
    """This account's bookmarks, most recently changed first.

    Bookmarks whose track is gone (deleted or renamed since) are left out
    rather than returned with an empty entry, which clients render as a
    blank row.
    """
    username = str(getattr(request.state, "username", ""))
    entries = [_payload(request, b, username) for b in _store(request).all()]
    listed = [e for e in entries if e is not None] + _book_bookmarks(request, username)
    return envelope("bookmarks", {"bookmark": listed})


@router.api_route("/createBookmark", methods=["GET", "POST", "HEAD"])
@router.api_route("/createBookmark.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def create_bookmark(
    request: Request,
    id: str = Query(),
    position: int = Query(default=0),
    comment: str = Query(default=""),
) -> dict:
    """Save a position (in milliseconds) inside track `id`. Re-saving moves it.

    On an audiobook file the position is translated onto the book's own
    timeline and kept in its progress store, so every client resumes at the
    same place.
    """
    books = _books(request)
    found = find_file(books, id) if books is not None else None
    if found is not None:
        book, number = found
        position_s = book.files[number].offset_s + position / 1000
        _progress(request).save(book.id, position_s, duration_s=book.duration_s)
        return envelope()
    if _cache(request).tracks_by_id.get(id) is None:
        return error_envelope(70, f"no track with id {id!r}")
    _store(request).save(id, position, comment=comment)
    return envelope()


@router.api_route("/deleteBookmark", methods=["GET", "POST", "HEAD"])
@router.api_route("/deleteBookmark.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def delete_bookmark(request: Request, id: str = Query()) -> dict:
    """Forget the bookmark on track `id`. Deleting one that is not there is fine.

    On an audiobook file this forgets the book's position, which is what the
    bookmark stands for.
    """
    books = _books(request)
    found = find_file(books, id) if books is not None else None
    if found is not None:
        _progress(request).delete(found[0].id)
        return envelope()
    _store(request).delete(id)
    return envelope()
