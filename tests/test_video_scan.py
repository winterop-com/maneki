"""Tests for the base video file discovery (no transcoding / no DB)."""

from __future__ import annotations

from pathlib import Path

import pytest

from mediakit.video.serve.scan import find_videos_dir, scan_videos


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """A library root containing a videos/ subdir with two .mkv files and one non-video file."""
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "Show.S01E01.1080p.mkv").write_bytes(b"\x1a\x45\xdf\xa3fake-mkv")
    (videos / "Show.S01E02.1080p.mkv").write_bytes(b"\x1a\x45\xdf\xa3fake-mkv-2")
    (videos / "notes.txt").write_text("ignore me", encoding="utf-8")
    return tmp_path


def test_find_videos_dir_matches_videos_subdir(library_root: Path) -> None:
    found = find_videos_dir(library_root)
    assert found == library_root / "videos"


def test_find_videos_dir_matches_video_singular(tmp_path: Path) -> None:
    (tmp_path / "video").mkdir()
    assert find_videos_dir(tmp_path) == tmp_path / "video"


def test_find_videos_dir_case_insensitive(tmp_path: Path) -> None:
    (tmp_path / "Videos").mkdir()
    assert find_videos_dir(tmp_path) == tmp_path / "Videos"


def test_find_videos_dir_none_when_absent(tmp_path: Path) -> None:
    (tmp_path / "music").mkdir()
    assert find_videos_dir(tmp_path) is None


def test_scan_videos_returns_two_entries(library_root: Path) -> None:
    entries = scan_videos(library_root)
    assert len(entries) == 2
    names = sorted(e["name"] for e in entries)
    assert names == ["Show.S01E01.1080p", "Show.S01E02.1080p"]


def test_scan_videos_skips_non_video_files(library_root: Path) -> None:
    entries = scan_videos(library_root)
    paths = [e["path"] for e in entries]
    assert not any(p.endswith(".txt") for p in paths)


def test_scan_videos_returns_empty_when_no_videos_dir(tmp_path: Path) -> None:
    assert scan_videos(tmp_path) == []


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


def test_scan_videos_walks_nested_layout(tmp_path: Path) -> None:
    """Both flat and Movies/Shows-organised layouts are returned."""
    videos = tmp_path / "videos"
    (videos / "Movies" / "Inception (2010)").mkdir(parents=True)
    (videos / "Movies" / "Inception (2010)" / "Inception.mkv").write_bytes(b"x" * 16)
    (videos / "Shows" / "X" / "Season 01").mkdir(parents=True)
    (videos / "Shows" / "X" / "Season 01" / "X - S01E01.mkv").write_bytes(b"y" * 32)

    entries = scan_videos(tmp_path)
    rel_paths = sorted(e["rel_path"] for e in entries)
    assert rel_paths == [
        "Movies/Inception (2010)/Inception.mkv",
        "Shows/X/Season 01/X - S01E01.mkv",
    ]
