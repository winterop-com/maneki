"""The books library index and the `/books` API that `maneki serve` mounts for `Audiobooks/`."""

from __future__ import annotations

import contextlib
import time
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio.serve.config import ServeConfig
from maneki.books import library as books_library
from maneki.books.library import BooksIndex, books_dir, find_book_dirs
from maneki.books.models import Chapter, ChapterSource
from maneki.books.write import BookTags, write_book
from maneki.serve_app import create_combined_app
from tests.conftest import jpeg_bytes, make_silent_mp3, require_ffmpeg

_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture(autouse=True)
def _need_ffmpeg() -> None:
    require_ffmpeg()


def _book(root: Path, author: str = "Daniel Kahneman", title: str = "Thinking, Fast and Slow") -> Path:
    """A book as `maneki books import` writes it, under `<root>/Audiobooks/`."""
    src = make_silent_mp3(root.parent / "src" / f"{title}.mp3", 6.0)
    folder = root / "Audiobooks" / author / title
    tags = BookTags(title=title, author=author, narrator="Patrick Egan", year="2011", cover_jpeg=jpeg_bytes())
    chapters = [Chapter(title="Opening", start_s=0.0, end_s=2.0), Chapter(title="One", start_s=2.0, end_s=6.0)]
    write_book(folder, [src], tags, chapters)
    return folder


# --- the index -----------------------------------------------------------------


def test_books_dir_matches_any_case(tmp_path: Path) -> None:
    (tmp_path / "AudioBooks").mkdir()
    assert books_dir(tmp_path) == tmp_path / "AudioBooks"
    assert books_dir(tmp_path / "missing") is None


def test_find_book_dirs_reads_author_title_and_bare_book_folders(tmp_path: Path) -> None:
    lib = tmp_path / "Audiobooks"
    make_silent_mp3(lib / "Andy Weir" / "Project Hail Mary" / "01.mp3", 0.5)
    make_silent_mp3(lib / "Loose Book" / "01.mp3", 0.5)
    make_silent_mp3(lib / "Andy Weir" / "The Martian" / "CD1" / "01.mp3", 0.5)
    (lib / ".hidden" / "x").mkdir(parents=True)
    rels = [p.relative_to(lib).as_posix() for p in find_book_dirs(lib)]
    assert rels == ["Andy Weir/Project Hail Mary", "Andy Weir/The Martian", "Loose Book"]


def test_index_reads_a_book_back_from_its_files(tmp_path: Path) -> None:
    _book(tmp_path)
    index = BooksIndex(tmp_path)
    index.rescan()
    [book] = index.books
    assert (book.author, book.title, book.narrator, book.year) == (
        "Daniel Kahneman",
        "Thinking, Fast and Slow",
        "Patrick Egan",
        "2011",
    )
    assert [c.title for c in book.chapters] == ["Opening", "One"]
    assert book.chapter_source is ChapterSource.FILE
    assert book.has_cover
    assert book.duration_s == pytest.approx(6.0, abs=0.2)


def test_a_warm_rescan_reuses_rows_and_a_changed_book_is_reread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = _book(tmp_path)
    BooksIndex(tmp_path).rescan()

    def refuse(path: Path) -> None:
        raise AssertionError(f"re-probed {path}")

    monkeypatch.setattr(books_library, "probe_file", refuse)
    warm = BooksIndex(tmp_path)
    warm.rescan()
    assert len(warm.books) == 1

    monkeypatch.undo()
    (folder / "cover.jpg").unlink()
    warm.rescan()
    assert warm.books[0].has_cover is False


def test_a_removed_book_leaves_the_index(tmp_path: Path) -> None:
    import shutil

    folder = _book(tmp_path)
    index = BooksIndex(tmp_path)
    index.rescan()
    shutil.rmtree(folder)
    index.rescan()
    assert index.books == []


# --- the API -------------------------------------------------------------------


@contextlib.contextmanager
def _served(root: Path) -> Generator[TestClient]:
    """The combined app running its lifespan, once the background books scan has finished."""
    with TestClient(create_combined_app(root=root, audio_cfg=_CFG)) as client:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = client.get("/books/api/scan").json()
            if not status["scanning"] and status["books"]:
                break
            time.sleep(0.05)
        yield client


def test_capabilities_advertise_books_only_when_the_folder_exists(tmp_path: Path) -> None:
    without = TestClient(create_combined_app(root=tmp_path, audio_cfg=_CFG)).get("/capabilities").json()
    assert without["books"] is False
    assert without["endpoints"]["books_api"] is None

    (tmp_path / "Audiobooks").mkdir()
    with_books = TestClient(create_combined_app(root=tmp_path, audio_cfg=_CFG)).get("/capabilities").json()
    assert with_books["books"] is True
    assert with_books["endpoints"]["books_api"] == "/books/api"


def test_list_detail_stream_and_cover(tmp_path: Path) -> None:
    _book(tmp_path)
    with _served(tmp_path) as client:
        [summary] = client.get("/books/api/books").json()
        assert summary["title"] == "Thinking, Fast and Slow"
        assert summary["chapters"] == 2

        detail = client.get(f"/books/api/books/{summary['id']}").json()
        assert [c["title"] for c in detail["chapter_list"]] == ["Opening", "One"]
        [file] = detail["files"]
        assert file["url"] == f"api/books/{summary['id']}/files/0"

        ranged = client.get(f"/books/{file['url']}", headers={"Range": "bytes=0-99"})
        assert ranged.status_code == 206
        assert len(ranged.content) == 100
        assert ranged.headers["content-type"] == "audio/mpeg"

        cover = client.get(f"/books/api/books/{summary['id']}/cover")
        assert cover.status_code == 200
        assert cover.headers["content-type"] == "image/jpeg"


def test_unknown_books_and_files_are_404(tmp_path: Path) -> None:
    _book(tmp_path)
    with _served(tmp_path) as client:
        assert client.get("/books/api/books/nope").status_code == 404
        [summary] = client.get("/books/api/books").json()
        assert client.get(f"/books/api/books/{summary['id']}/files/5").status_code == 404


def test_books_stay_out_of_the_music_library(tmp_path: Path) -> None:
    _book(tmp_path)
    caps = TestClient(create_combined_app(root=tmp_path, audio_cfg=_CFG)).get("/capabilities").json()
    assert caps["audio"] is False
    assert caps["books"] is True
