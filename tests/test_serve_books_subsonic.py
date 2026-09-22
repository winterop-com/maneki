"""Audiobooks through the Subsonic API: their own music folder, browsable and playable."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app
from maneki.books.library import BooksIndex
from maneki.books.models import Chapter
from maneki.books.subsonic import BOOKS_FOLDER_ID, MUSIC_FOLDER_ID, author_id, book_subsonic_id, file_id
from maneki.books.write import BookTags, write_book
from tests.conftest import jpeg_bytes, make_silent_mp3, require_ffmpeg

AUTHOR = "Daniel Kahneman"
TITLE = "Thinking, Fast and Slow"


@pytest.fixture(autouse=True)
def _need_ffmpeg() -> None:
    require_ffmpeg()


def _params(**extra: str | int) -> dict[str, str | int]:
    return {"u": "mort", "p": "secret", "f": "json", **extra}


def _music(root: Path) -> LibraryIndex:
    album_path = root / "Music" / "ABBA" / "1976 - Arrival"
    track = LibraryTrack(path=album_path / "01 - Dancing Queen.m4a", title="Dancing Queen", track_no=1)
    album = LibraryAlbum(
        path=album_path,
        artist_dir="ABBA",
        album_dir="1976 - Arrival",
        tag_album="Arrival",
        track_count=1,
        tracks=[track],
    )
    return LibraryIndex(root=root, albums=[album])


def _book(root: Path, *, parts: int = 1) -> BooksIndex:
    folder = root / "Audiobooks" / AUTHOR / TITLE
    sources = [make_silent_mp3(root / "src" / f"part{n}.mp3", 6.0) for n in range(parts)]
    tags = BookTags(title=TITLE, author=AUTHOR, narrator="Patrick Egan", year="2011", cover_jpeg=jpeg_bytes())
    chapters = [Chapter(title="Opening", start_s=0.0, end_s=2.0), Chapter(title="One", start_s=2.0, end_s=6.0)]
    write_book(folder, sources, tags, chapters)
    index = BooksIndex(root, use_cache=False)
    index.rescan()
    return index


def _client(tmp_path: Path, *, parts: int = 1) -> tuple[TestClient, BooksIndex]:
    books = _book(tmp_path, parts=parts)
    app = create_app(root=tmp_path, cfg=ServeConfig(username="mort", password="secret"), books=books)
    app.state.cache._reindex(_music(tmp_path))  # noqa: SLF001 - the test drives the music index directly
    return TestClient(app), books


def _inner(client: TestClient, path: str, **params: str | int) -> dict[str, Any]:
    body = client.get(f"/rest/{path}", params=_params(**params)).json()
    inner: dict[str, Any] = body["subsonic-response"]
    return inner


# --- the folder ----------------------------------------------------------------


def test_books_get_their_own_music_folder(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    folders = _inner(client, "getMusicFolders")["musicFolders"]["musicFolder"]
    assert folders == [{"id": MUSIC_FOLDER_ID, "name": "Music"}, {"id": BOOKS_FOLDER_ID, "name": "Audiobooks"}]


def test_artists_cover_both_folders_or_one(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)

    def names(**params: str | int) -> list[str]:
        index = _inner(client, "getArtists", **params)["artists"]["index"]
        return sorted(a["name"] for letter in index for a in letter["artist"])

    assert names() == ["ABBA", AUTHOR]
    assert names(musicFolderId=MUSIC_FOLDER_ID) == ["ABBA"]
    assert names(musicFolderId=BOOKS_FOLDER_ID) == [AUTHOR]
    # getIndexes is the same listing under another key.
    legacy = _inner(client, "getIndexes", musicFolderId=BOOKS_FOLDER_ID)["indexes"]["index"]
    assert [a["name"] for letter in legacy for a in letter["artist"]] == [AUTHOR]


# --- browsing ------------------------------------------------------------------


def test_an_author_lists_their_books(tmp_path: Path) -> None:
    client, books = _client(tmp_path)
    payload = _inner(client, "getArtist", id=author_id(AUTHOR))["artist"]
    assert payload["name"] == AUTHOR
    assert payload["albumCount"] == 1
    [album] = payload["album"]
    assert album["name"] == TITLE
    assert album["id"] == book_subsonic_id(books.books[0])


def test_a_book_reads_as_an_album_of_audiobook_songs(tmp_path: Path) -> None:
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]
    album = _inner(client, "getAlbum", id=book_subsonic_id(book))["album"]
    assert (album["name"], album["artist"], album["genre"]) == (TITLE, AUTHOR, "Audiobook")
    assert album["songCount"] == 2
    assert [s["type"] for s in album["song"]] == ["audiobook", "audiobook"]
    assert [s["track"] for s in album["song"]] == [1, 2]
    assert all(s["coverArt"] == book_subsonic_id(book) for s in album["song"])

    song = _inner(client, "getSong", id=file_id(book, 1))["song"]
    assert song["album"] == TITLE
    assert song["type"] == "audiobook"


def test_a_saved_position_rides_along_as_a_bookmark_position(tmp_path: Path) -> None:
    """A client reads bookmarkPosition to resume mid-book, so the server's position must reach it."""
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]
    client.app.state.users.progress_for("mort").save(book.id, 8.0, duration_s=book.duration_s)  # type: ignore[attr-defined]

    album = _inner(client, "getAlbum", id=book_subsonic_id(book))["album"]
    first, second = album["song"]
    assert "bookmarkPosition" not in first  # the position is past this file
    assert second["bookmarkPosition"] == pytest.approx(2000, abs=200)


def test_album_lists_honour_the_folder(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)

    def names(**params: str | int) -> list[str]:
        return [a["name"] for a in _inner(client, "getAlbumList2", **params)["albumList2"]["album"]]

    assert sorted(names(type="alphabeticalByName")) == ["Arrival", TITLE]
    assert names(type="alphabeticalByName", musicFolderId=MUSIC_FOLDER_ID) == ["Arrival"]
    assert names(type="alphabeticalByName", musicFolderId=BOOKS_FOLDER_ID) == [TITLE]
    assert names(type="byGenre", genre="Audiobook") == [TITLE]
    assert names(type="byGenre", genre="Pop") == []
    # Recently and most played come from music history, which books do not join.
    assert names(type="recent") == []


def test_search_finds_a_book_by_author_or_title(tmp_path: Path) -> None:
    client, books = _client(tmp_path)
    result = _inner(client, "search3", query="kahneman thinking")["searchResult3"]
    assert [a["name"] for a in result["album"]] == [TITLE]
    assert [a["name"] for a in result["artist"]] == [AUTHOR]
    assert [s["id"] for s in result["song"]] == [file_id(books.books[0], 0)]
    assert _inner(client, "search3", query="nothing here")["searchResult3"].get("album", []) == []


# --- playing -------------------------------------------------------------------


def test_stream_download_and_cover(tmp_path: Path) -> None:
    client, books = _client(tmp_path)
    book = books.books[0]

    streamed = client.get("/rest/stream", params=_params(id=file_id(book, 0)), headers={"Range": "bytes=0-99"})
    assert streamed.status_code == 206
    assert len(streamed.content) == 100

    downloaded = client.get("/rest/download", params=_params(id=file_id(book, 0)))
    assert downloaded.status_code == 200

    cover = client.get("/rest/getCoverArt", params=_params(id=book_subsonic_id(book)))
    assert cover.headers["content-type"] == "image/jpeg"
    resized = client.get("/rest/getCoverArt", params=_params(id=book_subsonic_id(book), size=100))
    assert resized.status_code == 200
    assert resized.headers["content-type"].startswith("image/")
    # An author id resolves to their first book's cover.
    assert client.get("/rest/getCoverArt", params=_params(id=author_id(AUTHOR))).status_code == 200


def test_unknown_book_ids_do_not_reach_the_music_index(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    assert _inner(client, "getAlbum", id="bkb_deadbeef")["status"] == "failed"
    assert _inner(client, "getSong", id="bkt_deadbeef_0")["status"] == "failed"
    assert _inner(client, "getArtist", id="bka_deadbeef")["status"] == "failed"


def test_a_root_without_books_is_unchanged(tmp_path: Path) -> None:
    app = create_app(root=tmp_path, cfg=ServeConfig(username="mort", password="secret"))
    app.state.cache._reindex(_music(tmp_path))  # noqa: SLF001 - the test drives the music index directly
    client = TestClient(app)
    assert _inner(client, "getMusicFolders")["musicFolders"]["musicFolder"] == [{"id": 1, "name": "Music"}]
    index = _inner(client, "getArtists")["artists"]["index"]
    assert [a["name"] for letter in index for a in letter["artist"]] == ["ABBA"]


# --- one position, every client ------------------------------------------------


def test_a_phone_bookmark_is_the_books_own_position(tmp_path: Path) -> None:
    """A bookmark on a book file is stored once, so the web app resumes where the phone stopped."""
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]
    progress = client.app.state.users.progress_for("mort")  # type: ignore[attr-defined]

    # A client saves a position two seconds into the second file.
    assert _inner(client, "createBookmark", id=file_id(book, 1), position=2000)["status"] == "ok"
    saved = progress.get(book.id)
    assert saved is not None
    assert saved.position_s == pytest.approx(book.files[1].offset_s + 2.0, abs=0.1)

    # It comes back as a bookmark on that same file.
    [bookmark] = _inner(client, "getBookmarks")["bookmarks"]["bookmark"]
    assert bookmark["entry"]["id"] == file_id(book, 1)
    assert bookmark["position"] == pytest.approx(2000, abs=200)
    assert bookmark["username"] == "mort"

    # And deleting it forgets the book's position.
    _inner(client, "deleteBookmark", id=file_id(book, 1))
    assert progress.get(book.id) is None
    assert _inner(client, "getBookmarks")["bookmarks"]["bookmark"] == []


def test_a_position_saved_elsewhere_shows_up_as_a_bookmark(tmp_path: Path) -> None:
    """The web app saves one number; a phone client sees it on the file it falls in."""
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]
    client.app.state.users.progress_for("mort").save(book.id, 8.0, duration_s=book.duration_s)  # type: ignore[attr-defined]

    [bookmark] = _inner(client, "getBookmarks")["bookmarks"]["bookmark"]
    assert bookmark["entry"]["id"] == file_id(book, 1)
    assert bookmark["entry"]["type"] == "audiobook"


# --- the folder browse (play:Sub walks the library this way) --------------------


def test_folder_browse_walks_author_then_book(tmp_path: Path) -> None:
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]

    author = _inner(client, "getMusicDirectory", id=author_id(AUTHOR))["directory"]
    assert author["name"] == AUTHOR
    [entry] = author["child"]
    assert entry["id"] == book_subsonic_id(book)
    assert entry["isDir"] is True

    listing = _inner(client, "getMusicDirectory", id=book_subsonic_id(book))["directory"]
    assert listing["name"] == TITLE
    assert listing["parent"] == author_id(AUTHOR)
    assert [c["id"] for c in listing["child"]] == [file_id(book, 0), file_id(book, 1)]
    assert all(c["type"] == "audiobook" for c in listing["child"])


def test_folder_browse_carries_the_saved_position(tmp_path: Path) -> None:
    client, books = _client(tmp_path, parts=2)
    book = books.books[0]
    client.app.state.users.progress_for("mort").save(book.id, 8.0, duration_s=book.duration_s)  # type: ignore[attr-defined]
    listing = _inner(client, "getMusicDirectory", id=book_subsonic_id(book))["directory"]
    assert "bookmarkPosition" in listing["child"][1]


def test_folder_browse_refuses_an_unknown_book(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    assert _inner(client, "getMusicDirectory", id="bkb_deadbeef")["status"] == "failed"


def test_scrobbling_a_book_file_is_accepted(tmp_path: Path) -> None:
    """Amperfy scrobbles every play; a book file must not come back an error."""
    client, books = _client(tmp_path)
    inner = _inner(client, "scrobble", id=file_id(books.books[0], 0))
    assert inner["status"] == "ok"
