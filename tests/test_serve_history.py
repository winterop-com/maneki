"""Per-user listening history — HistoryStore + getNowPlaying / recent albums."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app
from maneki.audio.serve.history import HistoryStore
from maneki.audio.serve.ids import track_id
from maneki.audio.serve.users import ResolvedUser, UserRegistry

# --- HistoryStore unit ------------------------------------------------------


def test_history_record_and_aggregations(tmp_path: Path) -> None:
    h = HistoryStore(tmp_path / "history.db")
    assert h.now_playing(now=1000.0) is None

    h.record("tr_a", submission=False, now=1000.0)  # now-playing probe
    assert h.now_playing(now=1001.0) == ("tr_a", 1000.0)
    assert h.now_playing(now=2000.0) is None  # outside the 600s window

    h.record("tr_a", submission=True, now=1010.0)
    h.record("tr_b", submission=True, now=1020.0)
    h.record("tr_a", submission=True, now=1030.0)
    assert h.play_count("tr_a") == 2
    assert h.play_count("tr_b") == 1
    assert h.recent_track_ids(10) == ["tr_a", "tr_b"]  # tr_a last at 1030 > tr_b 1020
    assert h.frequent_track_ids(10) == ["tr_a", "tr_b"]  # tr_a (2) > tr_b (1)


# --- HTTP ------------------------------------------------------------------


def _album(root: Path) -> LibraryAlbum:
    p = root / "ABBA" / "Arrival"
    return LibraryAlbum(
        path=p,
        artist_dir="ABBA",
        album_dir="Arrival",
        tag_album="Arrival",
        tag_year="1976",
        tag_album_artist="ABBA",
        track_count=1,
        tracks=[
            LibraryTrack(path=p / "01 - a.m4a", title="a", artist="ABBA", album="Arrival", track_no=1, duration_s=100.0)
        ],
    )


def _client(tmp_path: Path) -> tuple[TestClient, str]:
    app = create_app(root=tmp_path, cfg=ServeConfig(username="alice", password="apw"))
    app.state.users = UserRegistry(
        tmp_path,
        [ResolvedUser(name="alice", password="apw", admin=True), ResolvedUser(name="bob", password="bpw")],
    )
    album = _album(tmp_path)
    app.state.cache._reindex(LibraryIndex(root=tmp_path, albums=[album]))  # noqa: SLF001
    return TestClient(app), track_id(album.tracks[0])


def test_now_playing_is_cross_user(tmp_path: Path) -> None:
    client, tid = _client(tmp_path)
    # alice fires a now-playing probe (submission=false).
    client.get("/rest/scrobble", params={"u": "alice", "p": "apw", "f": "json", "id": tid, "submission": "false"})
    # Both alice and bob see "who's listening" (alice, on that track).
    for user, pw in (("alice", "apw"), ("bob", "bpw")):
        body = client.get("/rest/getNowPlaying", params={"u": user, "p": pw, "f": "json"}).json()
        entries = body["subsonic-response"]["nowPlaying"]["entry"]
        assert any(e["username"] == "alice" and e["id"] == tid for e in entries)


def test_recent_albums_from_history(tmp_path: Path) -> None:
    client, tid = _client(tmp_path)
    p = {"u": "alice", "p": "apw", "f": "json"}

    def _recent_albums() -> list:
        body = client.get("/rest/getAlbumList2", params={**p, "type": "recent"}).json()
        return list(body["subsonic-response"]["albumList2"].get("album", []))

    assert _recent_albums() == []  # no history yet
    client.get("/rest/scrobble", params={**p, "id": tid, "submission": "true"})
    assert len(_recent_albums()) == 1  # the played track's album surfaces
    # bob, who played nothing, still sees an empty recent list.
    bob_body = client.get("/rest/getAlbumList2", params={"u": "bob", "p": "bpw", "f": "json", "type": "recent"}).json()
    assert bob_body["subsonic-response"]["albumList2"].get("album", []) == []
