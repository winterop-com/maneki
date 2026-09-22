"""Subsonic bookmarks: a per-account resume position inside a track."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app
from maneki.audio.serve.bookmarks import BookmarkStore
from maneki.audio.serve.ids import track_id


def _params(**extra: str | int) -> dict[str, str | int]:
    return {"u": "mort", "p": "secret", "f": "json", **extra}


def _library(root: Path) -> LibraryIndex:
    album_path = root / "Daniel Kahneman" / "Thinking, Fast and Slow"
    tracks = [
        LibraryTrack(path=album_path / "01 - Part One.m4a", title="Part One", track_no=1, duration_s=3600.0),
        LibraryTrack(path=album_path / "02 - Part Two.m4a", title="Part Two", track_no=2, duration_s=3600.0),
    ]
    album = LibraryAlbum(
        path=album_path,
        artist_dir="Daniel Kahneman",
        album_dir="Thinking, Fast and Slow",
        tag_album="Thinking, Fast and Slow",
        track_count=len(tracks),
        tracks=tracks,
    )
    return LibraryIndex(root=root, albums=[album])


def _client(tmp_path: Path) -> tuple[TestClient, str]:
    app = create_app(root=tmp_path, cfg=ServeConfig(username="mort", password="secret"))
    index = _library(tmp_path)
    app.state.cache._reindex(index)  # noqa: SLF001 - the test drives the index directly
    return TestClient(app), track_id(index.albums[0].tracks[0])


# --- the store -----------------------------------------------------------------


def test_store_round_trip(tmp_path: Path) -> None:
    store = BookmarkStore(tmp_path / "bookmarks.db")
    assert store.all() == []
    assert store.get("tr_1") is None

    first = store.save("tr_1", 5000, comment="here", now=1000.0)
    assert (first.position_ms, first.comment, first.created_at) == (5000, "here", 1000.0)

    moved = store.save("tr_1", 9000, now=2000.0)
    assert moved.position_ms == 9000
    assert moved.created_at == 1000.0  # re-bookmarking keeps the original creation time
    assert moved.changed_at == 2000.0

    store.delete("tr_1")
    assert store.all() == []
    store.delete("tr_1")  # deleting a bookmark that is not there is fine


def test_store_clamps_a_negative_position(tmp_path: Path) -> None:
    store = BookmarkStore(tmp_path / "bookmarks.db")
    assert store.save("tr_1", -1).position_ms == 0


# --- the endpoints -------------------------------------------------------------


def test_create_list_and_delete(tmp_path: Path) -> None:
    client, tid = _client(tmp_path)
    assert client.get("/rest/getBookmarks", params=_params()).json()["subsonic-response"]["bookmarks"] == {
        "bookmark": []
    }

    created = client.get("/rest/createBookmark", params=_params(id=tid, position=1800000, comment="chapter 3"))
    assert created.json()["subsonic-response"]["status"] == "ok"

    [bookmark] = client.get("/rest/getBookmarks", params=_params()).json()["subsonic-response"]["bookmarks"]["bookmark"]
    assert bookmark["position"] == 1800000
    assert bookmark["username"] == "mort"
    assert bookmark["comment"] == "chapter 3"
    assert bookmark["entry"]["id"] == tid
    assert bookmark["entry"]["title"] == "Part One"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", bookmark["created"])

    client.get("/rest/deleteBookmark", params=_params(id=tid))
    assert client.get("/rest/getBookmarks", params=_params()).json()["subsonic-response"]["bookmarks"] == {
        "bookmark": []
    }


def test_bookmarking_an_unknown_track_is_an_error(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    inner = client.get("/rest/createBookmark", params=_params(id="tr_nope", position=1)).json()["subsonic-response"]
    assert inner["status"] == "failed"
    assert inner["error"]["code"] == 70


def test_a_bookmark_whose_track_is_gone_is_left_out(tmp_path: Path) -> None:
    """A track deleted since the bookmark was made would otherwise render as a blank row."""
    client, tid = _client(tmp_path)
    client.get("/rest/createBookmark", params=_params(id=tid, position=1000))
    client.app.state.cache._reindex(LibraryIndex(root=tmp_path, albums=[]))  # type: ignore[attr-defined]  # noqa: SLF001
    body = client.get("/rest/getBookmarks", params=_params()).json()
    assert body["subsonic-response"]["bookmarks"]["bookmark"] == []


def test_bookmarks_need_credentials(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    body = client.get("/rest/getBookmarks", params={"f": "json"}).json()
    assert body["subsonic-response"]["status"] == "failed"
