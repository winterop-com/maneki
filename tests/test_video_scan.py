"""Tests for the base video file discovery (no transcoding / no DB).

Library has no required subdirectory layout: video files anywhere
under the root are picked up. Cache dirs (.mediakit/) are skipped.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mediakit.video.serve.scan import has_videos, scan_videos


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """A library root with two flat .mkv files and a non-video file beside them."""
    (tmp_path / "Show.S01E01.1080p.mkv").write_bytes(b"\x1a\x45\xdf\xa3fake-mkv")
    (tmp_path / "Show.S01E02.1080p.mkv").write_bytes(b"\x1a\x45\xdf\xa3fake-mkv-2")
    (tmp_path / "notes.txt").write_text("ignore me", encoding="utf-8")
    return tmp_path


@pytest.fixture
def nested_layout(tmp_path: Path) -> Path:
    """Movies/Shows-organised layout - video files at varying depth under root."""
    (tmp_path / "Movies" / "Inception (2010)").mkdir(parents=True)
    (tmp_path / "Movies" / "Inception (2010)" / "Inception.mkv").write_bytes(b"x" * 16)
    (tmp_path / "Shows" / "X" / "Season 01").mkdir(parents=True)
    (tmp_path / "Shows" / "X" / "Season 01" / "X - S01E01.mkv").write_bytes(b"y" * 32)
    return tmp_path


def test_has_videos_true_when_video_present(library_root: Path) -> None:
    assert has_videos(library_root)


def test_has_videos_false_when_only_text(tmp_path: Path) -> None:
    (tmp_path / "readme.txt").write_text("nothing here", encoding="utf-8")
    assert not has_videos(tmp_path)


def test_has_videos_false_when_root_missing(tmp_path: Path) -> None:
    assert not has_videos(tmp_path / "nope")


def test_scan_videos_returns_flat_layout(library_root: Path) -> None:
    entries = scan_videos(library_root)
    assert len(entries) == 2
    names = sorted(e["name"] for e in entries)
    assert names == ["Show.S01E01.1080p", "Show.S01E02.1080p"]


def test_scan_videos_skips_non_video_files(library_root: Path) -> None:
    entries = scan_videos(library_root)
    paths = [e["path"] for e in entries]
    assert not any(p.endswith(".txt") for p in paths)


def test_scan_videos_returns_empty_when_no_videos(tmp_path: Path) -> None:
    """A root with no video files returns an empty list (not an error)."""
    assert scan_videos(tmp_path) == []


def test_scan_videos_returns_empty_when_root_missing(tmp_path: Path) -> None:
    assert scan_videos(tmp_path / "missing") == []


def test_scan_videos_ids_are_stable_and_unique(library_root: Path) -> None:
    entries = scan_videos(library_root)
    ids = [e["id"] for e in entries]
    assert len(set(ids)) == len(ids)
    # Re-scan should produce identical IDs.
    again = scan_videos(library_root)
    assert [e["id"] for e in again] == ids


def test_scan_videos_includes_size(library_root: Path) -> None:
    entries = scan_videos(library_root)
    for e in entries:
        assert e["size_bytes"] > 0


def test_scan_videos_walks_nested_layout(nested_layout: Path) -> None:
    """Files at arbitrary depth are surfaced; relative paths reflect the layout."""
    entries = scan_videos(nested_layout)
    rel_paths = sorted(e["rel_path"] for e in entries)
    assert rel_paths == [
        "Movies/Inception (2010)/Inception.mkv",
        "Shows/X/Season 01/X - S01E01.mkv",
    ]


def test_scan_videos_skips_mediakit_cache_dir(tmp_path: Path) -> None:
    """The server's own .mediakit/ cache must not be walked.

    Otherwise extracted-subtitle .vtt files etc could leak into the
    library list, and (worse) HLS .ts segments saved during playback
    could be presented as user videos.
    """
    (tmp_path / "real.mkv").write_bytes(b"\x1a\x45\xdf\xa3real")
    (tmp_path / ".mediakit").mkdir()
    (tmp_path / ".mediakit" / "fake.mkv").write_bytes(b"\x1a\x45\xdf\xa3fake")
    entries = scan_videos(tmp_path)
    rel_paths = [e["rel_path"] for e in entries]
    assert rel_paths == ["real.mkv"]


def test_scan_video_ids_do_not_collide_across_slug_aliases(tmp_path: Path) -> None:
    """`tv/ch01.mkv` and `tv-ch01.mkv` must get distinct IDs.

    The old scheme just replaced `/` with `-`, so a literal-hyphen flat
    filename collided with a nested file of the same stem. With single-
    library recursive scanning this is easy to hit (an episode in tv/
    plus a stray rip at the root with a hyphenated name) and the
    collision made one video unreachable AND silently cross-wired
    every cache keyed by video_id (HLS segments, posters, subtitles).
    """
    (tmp_path / "tv").mkdir()
    (tmp_path / "tv" / "ch01.mkv").write_bytes(b"\x1a\x45\xdf\xa3a")
    (tmp_path / "tv-ch01.mkv").write_bytes(b"\x1a\x45\xdf\xa3b")
    entries = scan_videos(tmp_path)
    ids = [e["id"] for e in entries]
    assert len(ids) == 2
    assert len(set(ids)) == 2, f"id collision: {ids}"


def test_scan_videos_picks_up_new_extensions(tmp_path: Path) -> None:
    """The expanded extension set covers .flv, .mpg, .vob etc."""
    (tmp_path / "old.flv").write_bytes(b"FLV\x01")
    (tmp_path / "dvd.vob").write_bytes(b"\x00" * 16)
    (tmp_path / "broadcast.mpg").write_bytes(b"\x00" * 16)
    entries = scan_videos(tmp_path)
    names = sorted(e["name"] for e in entries)
    assert names == ["broadcast", "dvd", "old"]
