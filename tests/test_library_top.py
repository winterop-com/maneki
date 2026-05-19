"""Tests for the top-level cross-cutting library scan + summary."""

from __future__ import annotations

from pathlib import Path

import pytest

from mediakit.library import (
    find_audio_dir,
    scan_files,
    summarize,
)


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "track1.m4a").write_bytes(b"a" * 100)
    (audio / "track2.flac").write_bytes(b"b" * 200)
    (audio / "notes.txt").write_text("ignore", encoding="utf-8")
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"v" * 300)
    return tmp_path


def test_find_audio_dir_matches_audio(library_root: Path) -> None:
    assert find_audio_dir(library_root) == library_root / "audio"


def test_find_audio_dir_matches_music(tmp_path: Path) -> None:
    (tmp_path / "music").mkdir()
    assert find_audio_dir(tmp_path) == tmp_path / "music"


def test_find_audio_dir_case_insensitive(tmp_path: Path) -> None:
    (tmp_path / "Audio").mkdir()
    assert find_audio_dir(tmp_path) == tmp_path / "Audio"


def test_summarize_counts_both_kinds(library_root: Path) -> None:
    s = summarize(library_root)
    assert s.audio_count == 2
    assert s.video_count == 1
    assert s.audio_dir == library_root / "audio"
    assert s.video_dir == library_root / "videos"


def test_summarize_empty_root(tmp_path: Path) -> None:
    s = summarize(tmp_path)
    assert s.is_empty
    assert s.audio_dir is None
    assert s.video_dir is None


def test_scan_files_returns_inventory(library_root: Path) -> None:
    result = scan_files(library_root)
    audio_names = sorted(e.rel_path.name for e in result.audio)
    video_names = sorted(e.rel_path.name for e in result.video)
    assert audio_names == ["track1.m4a", "track2.flac"]
    assert video_names == ["ep1.mkv"]
    # Sizes are surfaced
    assert all(e.size_bytes > 0 for e in result.audio)
    assert result.video[0].size_bytes == 300


def test_scan_files_skips_non_media(library_root: Path) -> None:
    result = scan_files(library_root)
    names = [e.rel_path.name for e in result.audio]
    assert "notes.txt" not in names


def test_scan_files_empty_root(tmp_path: Path) -> None:
    result = scan_files(tmp_path)
    assert result.audio == []
    assert result.video == []
