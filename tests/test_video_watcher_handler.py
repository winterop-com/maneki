"""Video watcher handler-level tests — extension filter + AppleDouble guard.

`test_serve_watcher.py` covers the audio Observer integration path; these
target the video `_Handler.on_any_event` directly so we can exercise the
file-extension and dot-prefix filters that real FS events don't reliably
reproduce — particularly the macOS AppleDouble `._<name>` sidecar churn
that would otherwise fire spurious rescans.
"""

from __future__ import annotations

from pathlib import Path

from watchdog.events import (
    DirCreatedEvent,
    DirModifiedEvent,
    FileCreatedEvent,
    FileMovedEvent,
)

from maneki.video.serve.watcher import _Handler


def _record_handler() -> tuple[_Handler, list[Path]]:
    captured: list[Path] = []
    return _Handler(captured.append), captured


def test_file_created_video_extension_triggers() -> None:
    """A new .mkv in the library fires the rescan."""
    handler, captured = _record_handler()
    handler.on_any_event(FileCreatedEvent(src_path="/lib/Movies/Wonder.mkv"))
    assert captured == [Path("/lib/Movies/Wonder.mkv")]


def test_file_created_non_video_filtered() -> None:
    """.DS_Store, posters, subtitle sidecars are non-video and must not fire."""
    handler, captured = _record_handler()
    handler.on_any_event(FileCreatedEvent(src_path="/lib/Movies/.DS_Store"))
    handler.on_any_event(FileCreatedEvent(src_path="/lib/Movies/poster.jpg"))
    handler.on_any_event(FileCreatedEvent(src_path="/lib/Movies/Wonder.srt"))
    assert captured == []


def test_appledouble_sidecar_is_ignored() -> None:
    """macOS `._<name>.mkv` AppleDouble stubs carry a video suffix but no media.

    The OS rewrites them constantly on FAT/exFAT/SMB volumes (USB sticks,
    NAS shares); without the dot-prefix guard each churn event passes the
    extension filter and fires a spurious debounced rescan.
    """
    handler, captured = _record_handler()
    handler.on_any_event(FileCreatedEvent(src_path="/lib/Movies/._Wonder.mkv"))
    assert captured == []


def test_appledouble_sidecar_move_is_ignored() -> None:
    """A move event whose only video-suffixed path is an AppleDouble stub must not fire."""
    handler, captured = _record_handler()
    handler.on_any_event(
        FileMovedEvent(
            src_path="/lib/Movies/._Wonder.mkv",
            dest_path="/lib/Movies/._Wonder.mkv.tmp",
        )
    )
    assert captured == []


def test_real_video_alongside_appledouble_still_triggers() -> None:
    """The guard rejects only the dotfile — a real video move still fires once."""
    handler, captured = _record_handler()
    handler.on_any_event(
        FileMovedEvent(
            src_path="/tmp/staging/Wonder.mkv",
            dest_path="/lib/Movies/Wonder.mkv",
        )
    )
    assert len(captured) == 1
    assert captured[0].name == "Wonder.mkv"


def test_dir_modified_events_are_ignored() -> None:
    """A dir modified event fires on any inner change (incl. ._* writes); too noisy."""
    handler, captured = _record_handler()
    handler.on_any_event(DirModifiedEvent(src_path="/lib/Movies"))
    assert captured == []


def test_dir_created_event_triggers() -> None:
    """Dropping a new directory fires even before video files land in it."""
    handler, captured = _record_handler()
    handler.on_any_event(DirCreatedEvent(src_path="/lib/Movies/New Season"))
    assert captured == [Path("/lib/Movies/New Season")]
