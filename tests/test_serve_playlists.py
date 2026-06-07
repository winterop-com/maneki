"""Per-user playlists — PlaylistStore + the Subsonic CRUD endpoints."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app
from maneki.audio.serve.ids import track_id
from maneki.audio.serve.playlists import PlaylistStore
from maneki.audio.serve.users import ResolvedUser, UserRegistry

# --- PlaylistStore unit -----------------------------------------------------


def test_playlist_store_crud(tmp_path: Path) -> None:
    store = PlaylistStore(tmp_path / "playlists", owner="alice")
    assert store.all() == []

    pl = store.create("Road trip", ["tr_a", "tr_b"])
    assert pl.id.startswith("pl_")
    assert pl.owner == "alice"
    assert pl.track_ids == ("tr_a", "tr_b")
    assert [p.id for p in store.all()] == [pl.id]

    # Reload from disk → same data (TOML round-trip).
    reloaded = store.get(pl.id)
    assert reloaded is not None
    assert reloaded.track_ids == ("tr_a", "tr_b")

    # append + remove-by-index + rename.
    up = store.update(pl.id, name="Trip", add_ids=["tr_c"], remove_indices=[0])
    assert up is not None
    assert up.name == "Trip"
    assert up.track_ids == ("tr_b", "tr_c")

    # set_ids replaces wholesale.
    rep = store.update(pl.id, set_ids=["tr_z"])
    assert rep is not None
    assert rep.track_ids == ("tr_z",)

    assert store.delete(pl.id) is True
    assert store.delete(pl.id) is False
    assert store.all() == []


# --- HTTP CRUD + per-user isolation -----------------------------------------


def _album(root: Path, artist: str, album: str) -> LibraryAlbum:
    p = root / artist / album
    return LibraryAlbum(
        path=p,
        artist_dir=artist,
        album_dir=album,
        tag_album=album,
        tag_year="2000",
        tag_album_artist=artist,
        track_count=2,
        tracks=[
            LibraryTrack(path=p / "01 - a.m4a", title="a", artist=artist, album=album, track_no=1, duration_s=100.0),
            LibraryTrack(path=p / "02 - b.m4a", title="b", artist=artist, album=album, track_no=2, duration_s=200.0),
        ],
    )


def _client(tmp_path: Path) -> tuple[TestClient, list[str]]:
    app = create_app(root=tmp_path, cfg=ServeConfig(username="alice", password="apw"))
    app.state.users = UserRegistry(
        tmp_path,
        [ResolvedUser(name="alice", password="apw", admin=True), ResolvedUser(name="bob", password="bpw")],
    )
    album = _album(tmp_path, "ABBA", "Arrival")
    app.state.cache._reindex(LibraryIndex(root=tmp_path, albums=[album]))  # noqa: SLF001
    return TestClient(app), [track_id(t) for t in album.tracks]


def _alice(**extra: str) -> dict[str, str]:
    return {"u": "alice", "p": "apw", "f": "json", **extra}


def test_playlist_http_crud_and_isolation(tmp_path: Path) -> None:
    client, track_ids = _client(tmp_path)

    # alice creates a playlist with both tracks.
    created = client.get("/rest/createPlaylist", params={**_alice(name="Mix"), "songId": track_ids}).json()
    pl = created["subsonic-response"]["playlist"]
    pid = pl["id"]
    assert pl["name"] == "Mix"
    assert pl["songCount"] == 2
    assert pl["duration"] == 300  # 100 + 200
    assert [e["id"] for e in pl["entry"]] == track_ids

    # alice sees it; bob does not.
    alice_pls = client.get("/rest/getPlaylists", params=_alice()).json()
    assert [p["id"] for p in alice_pls["subsonic-response"]["playlists"]["playlist"]] == [pid]
    bob_pls = client.get("/rest/getPlaylists", params={"u": "bob", "p": "bpw", "f": "json"}).json()
    assert bob_pls["subsonic-response"]["playlists"]["playlist"] == []

    # remove the first track, rename.
    client.get("/rest/updatePlaylist", params={**_alice(name="Mix2"), "playlistId": pid, "songIndexToRemove": 0})
    got = client.get("/rest/getPlaylist", params={**_alice(), "id": pid}).json()["subsonic-response"]["playlist"]
    assert got["name"] == "Mix2"
    assert [e["id"] for e in got["entry"]] == [track_ids[1]]

    # delete.
    client.get("/rest/deletePlaylist", params={**_alice(), "id": pid})
    assert client.get("/rest/getPlaylists", params=_alice()).json()["subsonic-response"]["playlists"]["playlist"] == []


def test_get_unknown_playlist_errors(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    body = client.get("/rest/getPlaylist", params={**_alice(), "id": "pl_nope"}).json()
    assert body["subsonic-response"]["status"] == "failed"
    assert body["subsonic-response"]["error"]["code"] == 70
