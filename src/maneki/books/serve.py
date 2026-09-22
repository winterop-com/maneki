"""The `/books` HTTP API: list books, read one with its chapters, stream its files, fetch its cover.

Mounted by `maneki serve` when the served root has an `Audiobooks/` folder.
Streaming is a plain file response with HTTP Range support, so a player
can seek anywhere in a twenty-hour file without the server decoding it.
"""

from __future__ import annotations

import mimetypes

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from maneki.books.library import COVER_NAME, BooksIndex, LibraryBook
from maneki.books.models import Chapter, ChapterSource

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


class ScanStatus(BaseModel):
    """Whether a rescan is running, and how many books the library holds."""

    scanning: bool
    books: int


def create_books_app(index: BooksIndex) -> FastAPI:
    """The books sub-app, reading from `index`."""
    app = FastAPI(title="maneki books", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.books_index = index

    def _book(book_id: str) -> LibraryBook:
        book = index.get(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail=f"no book {book_id!r}")
        return book

    @app.get("/api/books")
    def list_books() -> list[BookSummary]:
        """Every book, by author then title."""
        return [_summary(b) for b in index.books]

    @app.get("/api/books/{book_id}")
    def get_book(book_id: str) -> BookDetail:
        """One book with its files and chapters."""
        book = _book(book_id)
        return BookDetail(
            **_summary(book).model_dump(),
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
    def cover(book_id: str) -> FileResponse | Response:
        """The book's `cover.jpg`, else the picture embedded in its first file."""
        book = _book(book_id)
        folder_cover = index.file_path(f"{book.rel_path}/{COVER_NAME}")
        if folder_cover.is_file():
            return FileResponse(folder_cover, media_type="image/jpeg")
        from maneki.audio.metadata import read_source

        try:
            source = read_source(index.file_path(book.files[0].rel_path))
        except Exception as exc:  # noqa: BLE001 - an unreadable tag is simply no cover
            raise HTTPException(status_code=404, detail="no cover") from exc
        if not source.embedded_picture:
            raise HTTPException(status_code=404, detail="no cover")
        return Response(source.embedded_picture, media_type=source.embedded_picture_mime or "image/jpeg")

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


def _summary(book: LibraryBook) -> BookSummary:
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
    )
