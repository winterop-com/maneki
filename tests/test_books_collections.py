"""Collections: a marked folder under `Audiobooks/` whose files are items, grouped by subfolder, kept off the shelf."""

from __future__ import annotations

import contextlib
import time
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from maneki.audio.serve import create_app
from maneki.audio.serve.config import ServeConfig
from maneki.books.library import COLLECTION_MARKER, BooksIndex, find_book_dirs
from maneki.books.models import Chapter
from maneki.books.subsonic import (
    BOOKS_FOLDER_ID,
    FIRST_COLLECTION_FOLDER_ID,
    MUSIC_FOLDER_ID,
    collection_id,
    group_id,
)
from maneki.books.write import BookTags, write_book
from maneki.serve_app import create_combined_app
from tests.conftest import jpeg_bytes, make_silent_mp3, require_ffmpeg

_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture(autouse=True)
def _need_ffmpeg() -> None:
    require_ffmpeg()


def _library(root: Path) -> None:
    """One book on the shelf, and a Blinkist collection: two groups and one item outside any."""
    src = make_silent_mp3(root.parent / "src" / "book.mp3", 6.0)
    tags = BookTags(title="Thinking, Fast and Slow", author="Daniel Kahneman", cover_jpeg=jpeg_bytes())
    write_book(
        root / "Audiobooks" / "Daniel Kahneman" / "Thinking, Fast and Slow",
        [src],
        tags,
        [Chapter(title="One", start_s=0.0, end_s=6.0)],
    )
    blinkist = root / "Audiobooks" / "Blinkist"
    make_silent_mp3(blinkist / "Science" / "Carl Sagan - Cosmos.mp3", 3.0)
    make_silent_mp3(blinkist / "Science" / "Bill Bryson - A Short History of Nearly Everything.mp3", 3.0)
    make_silent_mp3(blinkist / "Productivity" / "Robin Sharma - The 5 AM Club.mp3", 3.0, title="The 5 AM Club")
    make_silent_mp3(blinkist / "Loose Note.mp3", 2.0)
    (blinkist / COLLECTION_MARKER).touch()
    (blinkist / "Science" / "cover.jpg").write_bytes(jpeg_bytes(300))


def _index(root: Path) -> BooksIndex:
    index = BooksIndex(root, use_cache=False)
    index.rescan()
    return index


# --- the index -----------------------------------------------------------------


def test_a_collection_is_not_an_author(tmp_path: Path) -> None:
    _library(tmp_path)
    assert [p.name for p in find_book_dirs(tmp_path / "Audiobooks")] == ["Thinking, Fast and Slow"]


def test_every_file_of_a_collection_is_an_item_of_its_group(tmp_path: Path) -> None:
    _library(tmp_path)
    index = _index(tmp_path)

    assert [b.title for b in index.shelf] == ["Thinking, Fast and Slow"]
    assert index.collections() == ["Blinkist"]
    assert index.groups("Blinkist") == ["Productivity", "Science"]

    science = {b.title: b for b in index.items("Blinkist", "Science")}
    assert set(science) == {"A Short History of Nearly Everything", "Cosmos"}
    assert science["Cosmos"].author == "Carl Sagan"
    assert science["Cosmos"].collection == "Blinkist"
    assert len(science["Cosmos"].files) == 1

    [loose] = [b for b in index.items("Blinkist") if b.group is None]
    assert (loose.title, loose.author) == ("Loose Note", "Blinkist")


def test_an_item_takes_its_groups_cover(tmp_path: Path) -> None:
    _library(tmp_path)
    index = _index(tmp_path)
    [cosmos] = [b for b in index.items("Blinkist", "Science") if b.title == "Cosmos"]
    [club] = index.items("Blinkist", "Productivity")
    assert index.cover_path(cosmos) == tmp_path / "Audiobooks" / "Blinkist" / "Science" / "cover.jpg"
    assert index.cover_path(club) is None


def test_a_warm_rescan_reuses_items_and_sees_a_new_cover(tmp_path: Path) -> None:
    _library(tmp_path)
    first = BooksIndex(tmp_path)
    first.rescan()
    [club] = first.items("Blinkist", "Productivity")
    assert not club.has_cover

    (tmp_path / "Audiobooks" / "Blinkist" / "cover.jpg").write_bytes(jpeg_bytes(300))
    second = BooksIndex(tmp_path)
    second.rescan()
    [club] = second.items("Blinkist", "Productivity")
    assert club.has_cover
    assert club.cover_rel == "Blinkist/cover.jpg"


# --- the books API -------------------------------------------------------------


@contextlib.contextmanager
def _served(root: Path) -> Generator[TestClient]:
    with TestClient(create_combined_app(root=root, audio_cfg=_CFG)) as client:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = client.get("/books/api/scan").json()
            if not status["scanning"] and status["books"]:
                break
            time.sleep(0.05)
        yield client


def test_the_shelf_lists_books_and_a_collection_is_asked_for_by_name(tmp_path: Path) -> None:
    _library(tmp_path)
    with _served(tmp_path) as client:
        assert [b["title"] for b in client.get("/books/api/books").json()] == ["Thinking, Fast and Slow"]

        science = client.get("/books/api/books", params={"collection": "Blinkist", "group": "Science"}).json()
        assert [b["title"] for b in science] == ["A Short History of Nearly Everything", "Cosmos"]
        assert {b["group"] for b in science} == {"Science"}

        everything = client.get("/books/api/books", params={"collection": "Blinkist"}).json()
        assert len(everything) == 4


def test_collections_count_their_groups_and_what_was_finished(tmp_path: Path) -> None:
    _library(tmp_path)
    with _served(tmp_path) as client:
        science = client.get("/books/api/books", params={"collection": "Blinkist", "group": "Science"}).json()
        done = client.put(f"/books/api/books/{science[0]['id']}/progress", json={"position_s": 0, "finished": True})
        assert done.status_code == 200

        [blinkist] = client.get("/books/api/collections").json()
        assert blinkist["name"] == "Blinkist"
        assert (blinkist["items"], blinkist["finished"]) == (4, 1)
        assert [(g["name"], g["items"], g["finished"]) for g in blinkist["groups"]] == [
            ("Productivity", 1, 0),
            ("Science", 2, 1),
            (None, 1, 0),
        ]

        # Each item keeps its own place: the other one in the group is untouched.
        again = client.get("/books/api/books", params={"collection": "Blinkist", "group": "Science"}).json()
        assert [b["finished"] for b in again] == [True, False]


def test_an_item_plays_and_shows_its_groups_cover(tmp_path: Path) -> None:
    _library(tmp_path)
    with _served(tmp_path) as client:
        [cosmos] = [
            b
            for b in client.get("/books/api/books", params={"collection": "Blinkist"}).json()
            if b["title"] == "Cosmos"
        ]
        assert cosmos["has_cover"] is True
        detail = client.get(f"/books/api/books/{cosmos['id']}").json()
        [file] = detail["files"]
        assert client.get(f"/books/{file['url']}").status_code == 200
        cover = client.get(f"/books/api/books/{cosmos['id']}/cover")
        assert cover.status_code == 200
        assert cover.headers["content-type"] == "image/jpeg"


# --- Subsonic ------------------------------------------------------------------


@contextlib.contextmanager
def _subsonic(root: Path) -> Generator[TestClient]:
    yield TestClient(create_app(root=root, cfg=_CFG, books=_index(root)))


def _inner(client: TestClient, path: str, **params: str | int) -> dict[str, Any]:
    body = client.get(f"/rest/{path}", params={"u": "admin", "p": "admin", "f": "json", **params}).json()
    inner: dict[str, Any] = body["subsonic-response"]
    return inner


def test_a_collection_is_a_music_folder_of_its_own(tmp_path: Path) -> None:
    _library(tmp_path)
    with _subsonic(tmp_path) as client:
        folders = _inner(client, "getMusicFolders")["musicFolders"]["musicFolder"]
        assert folders == [
            {"id": MUSIC_FOLDER_ID, "name": "Music"},
            {"id": BOOKS_FOLDER_ID, "name": "Audiobooks"},
            {"id": FIRST_COLLECTION_FOLDER_ID, "name": "Blinkist"},
        ]

        books_only = _inner(client, "getArtists", musicFolderId=BOOKS_FOLDER_ID)["artists"]["index"]
        assert [a["name"] for i in books_only for a in i["artist"]] == ["Daniel Kahneman"]

        blinkist = _inner(client, "getArtists", musicFolderId=FIRST_COLLECTION_FOLDER_ID)["artists"]["index"]
        assert [a["name"] for i in blinkist for a in i["artist"]] == ["Blinkist"]


def test_groups_are_albums_and_items_are_their_songs(tmp_path: Path) -> None:
    _library(tmp_path)
    with _subsonic(tmp_path) as client:
        artist = _inner(client, "getArtist", id=collection_id("Blinkist"))["artist"]
        assert [a["name"] for a in artist["album"]] == ["Productivity", "Science", "Blinkist"]

        album = _inner(client, "getAlbum", id=group_id("Blinkist", "Science"))["album"]
        assert [s["title"] for s in album["song"]] == ["A Short History of Nearly Everything", "Cosmos"]
        assert [s["track"] for s in album["song"]] == [1, 2]
        assert {s["albumId"] for s in album["song"]} == {group_id("Blinkist", "Science")}
        assert album["song"][1]["artist"] == "Carl Sagan"

        streamed = client.get("/rest/stream", params={"u": "admin", "p": "admin", "id": album["song"][0]["id"]})
        assert streamed.status_code == 200

        directory = _inner(client, "getMusicDirectory", id=group_id("Blinkist", "Science"))["directory"]
        assert [c["title"] for c in directory["child"]] == ["A Short History of Nearly Everything", "Cosmos"]

        cover = client.get(
            "/rest/getCoverArt", params={"u": "admin", "p": "admin", "id": group_id("Blinkist", "Science")}
        )
        assert cover.status_code == 200
        assert cover.headers["content-type"] == "image/jpeg"


def test_album_lists_keep_books_and_groups_in_their_folders(tmp_path: Path) -> None:
    _library(tmp_path)
    with _subsonic(tmp_path) as client:

        def names(folder: int) -> list[str]:
            listed = _inner(client, "getAlbumList2", type="alphabeticalByName", size=50, musicFolderId=folder)
            return [a["name"] for a in listed["albumList2"].get("album", [])]

        assert names(BOOKS_FOLDER_ID) == ["Thinking, Fast and Slow"]
        assert names(FIRST_COLLECTION_FOLDER_ID) == ["Blinkist", "Productivity", "Science"]


def test_search_finds_an_item_as_a_song_only(tmp_path: Path) -> None:
    _library(tmp_path)
    with _subsonic(tmp_path) as client:
        found = _inner(client, "search3", query="cosmos")["searchResult3"]
        assert [s["title"] for s in found.get("song", [])] == ["Cosmos"]
        assert not found.get("album")
        assert not found.get("artist")
