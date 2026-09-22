"""The `/books` HTTP API: list books, read one with its chapters, stream its files, fetch its cover.

Mounted by `maneki serve` when the served root has an `Audiobooks/` folder.
Streaming is a plain file response with HTTP Range support, so a player
can seek anywhere in a twenty-hour file without the server decoding it.
"""

from __future__ import annotations

import mimetypes

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from maneki.audio.serve.cover_cache import CoverCache
from maneki.audio.serve.covers import resize
from maneki.audio.serve.users import UserRegistry
from maneki.books.library import COVER_NAME, BooksIndex, LibraryBook
from maneki.books.models import Chapter, ChapterSource
from maneki.books.progress import BookProgress, ProgressStore

_AUDIO_TYPES = {".mp3": "audio/mpeg", ".m4b": "audio/mp4", ".m4a": "audio/mp4", ".flac": "audio/flac"}


class BookSummary(BaseModel):
    """One row of the book list."""

    id: str
    title: str
    author: str
    narrator: str | None
    year: str | None
    series: str | None
    series_position: str | None
    duration_s: float
    chapters: int
    has_cover: bool
    # Where this user stopped, so one request fills a shelf with resume points.
    position_s: float = 0.0
    finished: bool = False


class BookFile(BaseModel):
    """One audio file of a book, placed on the book's timeline."""

    index: int
    duration_s: float
    offset_s: float
    size_bytes: int
    url: str


class BookDetail(BookSummary):
    """A book with everything a player needs: its files, in order, and its chapters."""

    description: str | None
    asin: str | None
    chapter_source: ChapterSource
    chapter_list: list[Chapter]
    files: list[BookFile]


class ProgressUpdate(BaseModel):
    """A player reporting where it is in a book."""

    position_s: float = Field(ge=0)
    # Left unset, a position in the book's last minute counts as finished.
    finished: bool | None = None


class ScanStatus(BaseModel):
    """Whether a rescan is running, and how many books the library holds."""

    scanning: bool
    books: int


def create_books_app(index: BooksIndex, *, users: UserRegistry | None = None) -> FastAPI:
    """The books sub-app, reading from `index`. `users` scopes listening positions per account."""
    app = FastAPI(title="maneki books", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.books_index = index
    # Scaled covers, kept so a shelf of two hundred books is two hundred
    # resizes once rather than on every visit.
    _covers = CoverCache()
    app.state.cover_cache = _covers

    def _book(book_id: str) -> LibraryBook:
        book = index.get(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail=f"no book {book_id!r}")
        return book

    def _progress(request: Request) -> ProgressStore:
        """The listening positions of whoever is asking.

        `BearerAuthMiddleware` stamps the account on the request under
        `--auth`. Without it there is one implicit account, the admin, and
        every position lands there — the same fallback the video API uses.
        """
        if users is None:
            raise HTTPException(status_code=503, detail="user registry unavailable; positions are not saved")
        name = getattr(request.state, "username", None)
        if not name:
            accounts = users.all()
            admin = next((u for u in accounts if u.admin), None) or (accounts[0] if accounts else None)
            name = admin.name if admin else "default"
        return users.progress_for(str(name))

    @app.get("/api/books")
    def list_books(request: Request) -> list[BookSummary]:
        """Every book, by author then title, each with this user's position in it."""
        saved = {p.book_id: p for p in _progress(request).all()}
        return [_summary(b, saved.get(b.id)) for b in index.books]

    @app.get("/api/books/{book_id}")
    def get_book(book_id: str, request: Request) -> BookDetail:
        """One book with its files, chapters and this user's position."""
        book = _book(book_id)
        return BookDetail(
            **_summary(book, _progress(request).get(book_id)).model_dump(),
            description=book.description,
            asin=book.asin,
            chapter_source=book.chapter_source,
            chapter_list=book.chapters,
            files=[
                BookFile(
                    index=i,
                    duration_s=f.duration_s,
                    offset_s=f.offset_s,
                    size_bytes=f.size_bytes,
                    url=f"api/books/{book.id}/files/{i}",
                )
                for i, f in enumerate(book.files)
            ],
        )

    @app.get("/api/books/{book_id}/files/{file_index}")
    def stream_file(book_id: str, file_index: int) -> FileResponse:
        """One of the book's files as stored, with HTTP Range support for seeking."""
        book = _book(book_id)
        if not 0 <= file_index < len(book.files):
            raise HTTPException(status_code=404, detail=f"book {book_id!r} has no file {file_index}")
        path = index.file_path(book.files[file_index].rel_path)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="the file is gone; a rescan will catch up")
        media_type = _AUDIO_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
        return FileResponse(path, media_type=media_type or "application/octet-stream")

    @app.get("/api/books/{book_id}/cover", response_model=None)
    def cover(book_id: str, size: int | None = Query(default=None, ge=1, le=2000)) -> FileResponse | Response:
        """The book's `cover.jpg`, else the picture embedded in its first file.

        `?size=N` fits the image inside an N-pixel box, cached per book and
        size. A shelf draws two hundred of these at once: at full resolution
        that is tens of megabytes to send and two hundred full-size JPEG
        decodes for the browser, which is felt as a window that stops
        answering the pointer. A card is 200px wide and asks for what it draws.
        """
        book = _book(book_id)
        cached = _covers.get((book_id, size))
        if cached is not None:
            return Response(content=cached[0], media_type=cached[1])

        folder_cover = index.file_path(f"{book.rel_path}/{COVER_NAME}")
        if folder_cover.is_file():
            if size is None:
                return FileResponse(folder_cover, media_type="image/jpeg")
            raw, mime = folder_cover.read_bytes(), "image/jpeg"
        else:
            from maneki.audio.metadata import read_source

            try:
                source = read_source(index.file_path(book.files[0].rel_path))
            except Exception as exc:  # noqa: BLE001 - an unreadable tag is simply no cover
                raise HTTPException(status_code=404, detail="no cover") from exc
            if not source.embedded_picture:
                raise HTTPException(status_code=404, detail="no cover")
            raw, mime = source.embedded_picture, source.embedded_picture_mime or "image/jpeg"
            if size is None:
                return Response(raw, media_type=mime)

        try:
            data, mime = resize(raw, max_size=size)
        except Exception:  # noqa: BLE001 - Pillow refused; the original is still a cover
            return Response(raw, media_type=mime)
        _covers.put((book_id, size), data, mime)
        return Response(content=data, media_type=mime)

    @app.get("/api/progress")
    def list_progress(request: Request) -> list[BookProgress]:
        """Every book this user has started, most recent first. Books no longer in the library are left out."""
        return [p for p in _progress(request).all() if index.get(p.book_id) is not None]

    @app.get("/api/books/{book_id}/progress")
    def get_progress(book_id: str, request: Request) -> BookProgress:
        """Where this user stopped. A book never started reads as position 0."""
        _book(book_id)
        saved = _progress(request).get(book_id)
        return saved or BookProgress(book_id=book_id, position_s=0.0, finished=False, updated_at=0.0)

    @app.put("/api/books/{book_id}/progress")
    def save_progress(book_id: str, update: ProgressUpdate, request: Request) -> BookProgress:
        """Record where this user is in the book. Safe to call every few seconds."""
        book = _book(book_id)
        return _progress(request).save(
            book_id,
            update.position_s,
            duration_s=book.duration_s,
            finished=update.finished,
        )

    @app.delete("/api/books/{book_id}/progress", status_code=204)
    def clear_progress(book_id: str, request: Request) -> None:
        """Forget the position, so the book starts from the beginning."""
        _book(book_id)
        _progress(request).delete(book_id)

    @app.get("/api/scan")
    def scan_status() -> ScanStatus:
        """Whether a rescan is running."""
        return ScanStatus(scanning=index.scan_in_progress, books=len(index.books))

    @app.post("/api/scan")
    def start_scan() -> ScanStatus:
        """Rescan the books folder in the background; only changed books are re-read."""
        index.start_background_rescan()
        return ScanStatus(scanning=True, books=len(index.books))

    return app


def _summary(book: LibraryBook, progress: BookProgress | None = None) -> BookSummary:
    return BookSummary(
        id=book.id,
        title=book.title,
        author=book.author,
        narrator=book.narrator,
        year=book.year,
        series=book.series,
        series_position=book.series_position,
        duration_s=book.duration_s,
        chapters=len(book.chapters),
        has_cover=book.has_cover,
        position_s=progress.position_s if progress else 0.0,
        finished=progress.finished if progress else False,
    )
