"""When an album came into the library: its `created`, and what "newest" lists first."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app

OLD = 1_600_000_000  # 2020-09-13
NEW = 1_700_000_000  # 2023-11-14


def _album(root: Path, name: str, added: float) -> LibraryAlbum:
    path = root / "Artist" / name
    path.mkdir(parents=True)
    track = path / "01.flac"
    track.write_bytes(b"x")
    os.utime(path, (added, added))
    return LibraryAlbum(
        path=path,
        artist_dir="Artist",
        album_dir=name,
        tag_album=name,
        track_count=1,
        tracks=[LibraryTrack(path=track, title="One", artist="Artist", album=name, track_no=1, duration_s=1.0)],
    )


def test_every_album_is_not_from_1970_and_newest_is_newest_first(tmp_path: Path) -> None:
    """Every album said it was created 1970-01-01 and "newest" fell back to alphabetical, so other
    Subsonic clients' "Recently added" shelves listed A to Z."""
    app = create_app(root=tmp_path, cfg=ServeConfig(username="mort", password="secret"))
    app.state.cache._reindex(  # noqa: SLF001 - the test drives the index directly
        LibraryIndex(root=tmp_path, albums=[_album(tmp_path, "Alpha", OLD), _album(tmp_path, "Zulu", NEW)])
    )
    client = TestClient(app)
    params = {"u": "mort", "p": "secret", "f": "json", "type": "newest"}
    albums = client.get("/rest/getAlbumList2", params=params).json()["subsonic-response"]["albumList2"]["album"]
    assert [a["name"] for a in albums] == ["Zulu", "Alpha"]
    assert albums[0]["created"].startswith("2023-11-14")
    assert albums[1]["created"].startswith("2020-09-13")
