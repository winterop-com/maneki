"""A library root that goes away (an unplugged drive) is survived, and not remembered."""

from __future__ import annotations

from pathlib import Path

import pytest

from maneki.audio.serve.history import HistoryStore
from maneki.audio.serve.payloads import album_added
from maneki.audio.serve.playlists import PlaylistStore, PlaylistStoreError


def _blocked(tmp_path: Path) -> Path:
    """A folder that cannot be made: a file stands where it should be."""
    wall = tmp_path / "users"
    wall.write_text("a file where the folder should be")
    return wall / "alice" / "history.db"


def test_history_on_an_unwritable_root_answers_empty_rather_than_failing(tmp_path: Path) -> None:
    # Every scrobble and the recent / frequent lists answered a bare 500 with a traceback.
    store = HistoryStore(_blocked(tmp_path))
    store.record("tr_1", submission=True)
    assert store.recent_track_ids(10) == []
    assert store.frequent_track_ids(10) == []
    assert store.now_playing() is None
    assert store.play_count("tr_1") == 0


def test_a_playlist_that_cannot_be_saved_does_not_name_the_disk(tmp_path: Path) -> None:
    wall = tmp_path / "playlists"
    wall.write_text("a file where the folder should be")
    with pytest.raises(PlaylistStoreError) as refused:
        PlaylistStore(wall, owner="alice").create("Mixtape", ["tr_1"])
    assert str(tmp_path) not in str(refused.value)
    assert "Errno" not in str(refused.value)


def test_a_folder_time_that_could_not_be_read_is_read_again(tmp_path: Path) -> None:
    # Read while the drive was gone, an album said 1970 until the server restarted.
    from maneki.audio.library.models import LibraryAlbum

    folder = tmp_path / "Artist" / "Album"
    album = LibraryAlbum(
        path=folder,
        artist_dir="Artist",
        album_dir="Album",
        tag_album="Album",
        tag_year="2000",
        tag_album_artist="Artist",
        track_count=0,
        tracks=[],
    )
    assert album_added(album) == 0.0
    folder.mkdir(parents=True)
    assert album_added(album) > 0
