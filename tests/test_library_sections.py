"""The top-level inbox and books folders are kept out of the music and video walks.

A served root such as `/Volumes/T9/Media` holds `Music/`, video folders,
`inbox/` (raw rips awaiting `maneki audio convert`) and `Audiobooks/`
(the books section). Only the first two are music or video.
"""

from __future__ import annotations

from pathlib import Path

from watchdog.events import DirCreatedEvent, FileCreatedEvent, FileMovedEvent

from maneki.audio import library
from maneki.audio.library.scan import _iter_album_dirs
from maneki.audio.serve.watcher import _Handler as AudioHandler
from maneki.library import has_audio, is_media_path, skips_dir, summarize
from maneki.video.serve.scan import _iter_video_files, browse_dir
from maneki.video.serve.watcher import _Handler as VideoHandler
from tests.test_library import _make_track

_MKV = b"\x1a\x45\xdf\xa3" + b"x" * 64


def _touch(path: Path, data: bytes = b"a" * 64) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# --- the rule -----------------------------------------------------------------


def test_skips_dir_names_inbox_and_books_at_the_top_in_any_case(tmp_path: Path) -> None:
    for name in ("inbox", "Inbox", "INBOX", "Audiobooks", "audiobooks", "AudioBooks"):
        assert skips_dir(tmp_path / name, at_root=True), name


def test_skips_dir_leaves_the_same_names_alone_below_the_top(tmp_path: Path) -> None:
    assert not skips_dir(tmp_path / "Music" / "inbox", at_root=False)
    assert not skips_dir(tmp_path / "Music" / "Audiobooks", at_root=False)


def test_skips_dir_skips_the_server_cache_at_any_depth(tmp_path: Path) -> None:
    assert skips_dir(tmp_path / ".maneki", at_root=True)
    assert skips_dir(tmp_path / "Music" / ".git", at_root=False)


def test_skips_dir_keeps_ordinary_folders(tmp_path: Path) -> None:
    assert not skips_dir(tmp_path / "Music", at_root=True)
    assert not skips_dir(tmp_path / "Star Trek", at_root=True)


def test_is_media_path(tmp_path: Path) -> None:
    assert is_media_path(tmp_path, tmp_path / "Music" / "A" / "01.flac")
    assert not is_media_path(tmp_path, tmp_path / "inbox" / "music" / "01.flac")
    assert not is_media_path(tmp_path, tmp_path / "Inbox")
    assert not is_media_path(tmp_path, tmp_path / "Audiobooks" / "Author" / "Book" / "01.mp3")
    assert not is_media_path(tmp_path, tmp_path / ".maneki" / "index.db")
    assert is_media_path(tmp_path, tmp_path / "Music" / "inbox" / "01.flac")


# --- summarise / has_audio ---------------------------------------------------


def test_has_audio_is_false_when_only_inbox_and_books_hold_audio(tmp_path: Path) -> None:
    _touch(tmp_path / "inbox" / "music" / "Album" / "01.flac")
    _touch(tmp_path / "Audiobooks" / "Author" / "Book" / "01.mp3")
    assert has_audio(tmp_path) is False
    assert summarize(tmp_path).audio_count == 0


def test_summarize_counts_a_folder_named_inbox_below_the_top(tmp_path: Path) -> None:
    _touch(tmp_path / "Music" / "Inbox" / "Album" / "01.flac")
    assert summarize(tmp_path).audio_count == 1


# --- the audio index ---------------------------------------------------------


def test_album_walk_prunes_inbox_books_and_the_server_cache(tmp_path: Path) -> None:
    album = tmp_path / "Music" / "Artist" / "2020 - Album"
    _touch(album / "01.m4a")
    _touch(tmp_path / "inbox" / "music" / "Rip" / "01.flac")
    _touch(tmp_path / "Audiobooks" / "Author" / "Book" / "01.mp3")
    _touch(tmp_path / ".maneki" / "stray.mp3")
    assert _iter_album_dirs(tmp_path) == [album]


def test_album_walk_ignores_appledouble_sidecars(tmp_path: Path) -> None:
    _touch(tmp_path / "Music" / "Artist" / "Album" / "._01.flac", b"\x00" * 16)
    assert _iter_album_dirs(tmp_path) == []


def test_album_moved_into_the_inbox_drops_out_of_the_index(tmp_path: Path, silent_flac: Path) -> None:
    """A warm index forgets an album once it sits under `inbox/`."""
    root = tmp_path / "lib"
    _make_track(root / "Staging" / "Album", silent_flac, filename="01 - Track.m4a")
    assert len(library.load_or_scan(root).albums) == 1

    (root / "Staging").rename(root / "inbox")
    assert library.load_or_scan(root).albums == []


# --- the video walk ----------------------------------------------------------


def test_video_walk_prunes_inbox_and_books(tmp_path: Path) -> None:
    movie = _touch(tmp_path / "Movies" / "film.mkv", _MKV)
    _touch(tmp_path / "inbox" / "clip.mkv", _MKV)
    _touch(tmp_path / "Audiobooks" / "Author" / "Book" / "extra.mp4", _MKV)
    assert list(_iter_video_files(tmp_path)) == [movie]


def test_browse_hides_inbox_and_books_and_refuses_to_enter_them(tmp_path: Path) -> None:
    _touch(tmp_path / "Movies" / "film.mkv", _MKV)
    _touch(tmp_path / "inbox" / "clip.mkv", _MKV)
    _touch(tmp_path / "Audiobooks" / "extra.mp4", _MKV)
    listing = browse_dir(tmp_path)
    assert listing is not None
    assert [f.name for f in listing.folders] == ["Movies"]
    assert browse_dir(tmp_path, "inbox") is None
    assert browse_dir(tmp_path, "Audiobooks") is None


def test_browse_counts_a_folder_named_inbox_inside_a_show(tmp_path: Path) -> None:
    _touch(tmp_path / "Shows" / "inbox" / "ep.mkv", _MKV)
    listing = browse_dir(tmp_path)
    assert listing is not None
    assert [(f.name, f.video_count) for f in listing.folders] == [("Shows", 1)]


# --- the watchers ------------------------------------------------------------


def test_audio_watcher_drops_events_under_inbox_and_books(tmp_path: Path) -> None:
    captured: list[Path] = []
    handler = AudioHandler(captured.append, root=tmp_path)
    handler.on_any_event(FileCreatedEvent(src_path=str(tmp_path / "inbox" / "music" / "01.flac")))
    handler.on_any_event(FileCreatedEvent(src_path=str(tmp_path / "Audiobooks" / "A" / "B" / "01.mp3")))
    handler.on_any_event(DirCreatedEvent(src_path=str(tmp_path / "inbox" / "books" / "New Book")))
    assert captured == []


def test_audio_watcher_fires_for_the_library(tmp_path: Path) -> None:
    captured: list[Path] = []
    handler = AudioHandler(captured.append, root=tmp_path)
    track = tmp_path / "Music" / "Artist" / "Album" / "01.m4a"
    handler.on_any_event(FileCreatedEvent(src_path=str(track)))
    assert captured == [track]


def test_audio_watcher_fires_for_an_album_moved_out_of_the_inbox(tmp_path: Path) -> None:
    captured: list[Path] = []
    handler = AudioHandler(captured.append, root=tmp_path)
    src = tmp_path / "inbox" / "music" / "01.m4a"
    dest = tmp_path / "Music" / "Artist" / "Album" / "01.m4a"
    handler.on_any_event(FileMovedEvent(src_path=str(src), dest_path=str(dest)))
    assert captured != []


def test_audio_watcher_ignores_appledouble_sidecars(tmp_path: Path) -> None:
    captured: list[Path] = []
    handler = AudioHandler(captured.append, root=tmp_path)
    handler.on_any_event(FileCreatedEvent(src_path=str(tmp_path / "Music" / "Album" / "._01.flac")))
    assert captured == []


def test_video_watcher_drops_events_under_inbox(tmp_path: Path) -> None:
    captured: list[Path] = []
    handler = VideoHandler(captured.append, root=tmp_path)
    handler.on_any_event(FileCreatedEvent(src_path=str(tmp_path / "inbox" / "clip.mkv")))
    assert captured == []
    movie = tmp_path / "Movies" / "film.mkv"
    handler.on_any_event(FileCreatedEvent(src_path=str(movie)))
    assert captured == [movie]
