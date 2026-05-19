"""Tests for the top-level cross-cutting library scan + summary.

MediaKit treats a library as a single directory — both kinds are
scanned from the same root with no subdirectory convention. These
tests cover both the conventional `<root>/audio/` + `<root>/videos/`
layout (which still works because the scanners walk recursively) and
mixed layouts where audio + video sit at arbitrary depth.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mediakit.library import has_audio, has_video, scan_files, summarize


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """Conventional <root>/{audio,videos}/ layout."""
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "track1.m4a").write_bytes(b"a" * 100)
    (audio / "track2.flac").write_bytes(b"b" * 200)
    (audio / "notes.txt").write_text("ignore", encoding="utf-8")
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"v" * 300)
    return tmp_path


@pytest.fixture
def mixed_root(tmp_path: Path) -> Path:
    """Audio and video sitting at different depths under the same root, no canonical subdirs."""
    (tmp_path / "Music" / "Artist" / "Album").mkdir(parents=True)
    (tmp_path / "Music" / "Artist" / "Album" / "01.flac").write_bytes(b"a" * 50)
    (tmp_path / "Movies").mkdir()
    (tmp_path / "Movies" / "movie.mkv").write_bytes(b"v" * 100)
    (tmp_path / "Movies" / "another.mp4").write_bytes(b"v" * 200)
    return tmp_path


def test_has_audio_true_when_audio_present(library_root: Path) -> None:
    assert has_audio(library_root)


def test_has_audio_false_when_no_audio(tmp_path: Path) -> None:
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "x.mkv").write_bytes(b"v")
    assert not has_audio(tmp_path)


def test_has_video_true_when_video_present(library_root: Path) -> None:
    assert has_video(library_root)


def test_has_video_false_when_no_video(tmp_path: Path) -> None:
    (tmp_path / "audio").mkdir()
    (tmp_path / "audio" / "x.flac").write_bytes(b"a")
    assert not has_video(tmp_path)


def test_summarize_counts_both_kinds(library_root: Path) -> None:
    s = summarize(library_root)
    assert s.audio_count == 2
    assert s.video_count == 1
    assert not s.is_empty


def test_summarize_empty_root(tmp_path: Path) -> None:
    s = summarize(tmp_path)
    assert s.audio_count == 0
    assert s.video_count == 0
    assert s.is_empty


def test_summarize_mixed_layout_finds_both(mixed_root: Path) -> None:
    """Audio + video at different paths under one root - no subdir convention required."""
    s = summarize(mixed_root)
    assert s.audio_count == 1
    assert s.video_count == 2


def test_summarize_skips_mediakit_cache_dir(tmp_path: Path) -> None:
    """The server's own .mediakit/ cache dir must not be walked when summarising."""
    (tmp_path / ".mediakit").mkdir()
    # An audio file inside .mediakit/ must NOT be counted (it would be
    # an internal artefact, not library content).
    (tmp_path / ".mediakit" / "fake.flac").write_bytes(b"a")
    (tmp_path / "real.flac").write_bytes(b"a")
    s = summarize(tmp_path)
    assert s.audio_count == 1


def test_scan_files_returns_inventory(library_root: Path) -> None:
    result = scan_files(library_root)
    audio_names = sorted(e.rel_path.name for e in result.audio)
    video_names = sorted(e.rel_path.name for e in result.video)
    assert audio_names == ["track1.m4a", "track2.flac"]
    assert video_names == ["ep1.mkv"]
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


def test_mp4_is_video_not_audio(mixed_root: Path) -> None:
    """An .mp4 in the library counts as video — never as audio.

    In a single-library scan the .mp4 container is overwhelmingly used
    for video; treating it as audio (as the upstream MusicKit code did)
    produces phantom albums for every movie folder. The fix is to drop
    .mp4 from the audio extension set entirely.
    """
    s = summarize(mixed_root)
    # `another.mp4` lives under Movies/ and must contribute to
    # video_count, not audio_count.
    assert s.video_count == 2
    assert s.audio_count == 1


def test_ogg_is_audio_not_video(tmp_path: Path) -> None:
    """`.ogg` is Vorbis audio - must NOT be in the video extension set.

    Regression test: when .ogg appeared in both AUDIO and VIDEO extension
    sets, an Ogg Vorbis library would get both /audio/rest/* AND
    /video/api/* mounts, and the same files would be listed by both
    scanners. The video pipeline would then choke trying to ffprobe
    audio-only Ogg files as videos.
    """
    (tmp_path / "song.ogg").write_bytes(b"OggS\x00" + b"x" * 32)
    s = summarize(tmp_path)
    assert s.audio_count == 1
    assert s.video_count == 0


def test_library_and_subsonic_audio_extension_sets_agree() -> None:
    """`library.AUDIO_EXTENSIONS` must equal `audio.metadata.SUPPORTED_AUDIO_EXTS`.

    They are kept in sync as a single import - drifting them apart
    causes silent bugs (e.g. has_audio() returns True on a library
    that the Subsonic scanner then finds empty).
    """
    from mediakit.audio.metadata import SUPPORTED_AUDIO_EXTS
    from mediakit.library import AUDIO_EXTENSIONS

    assert AUDIO_EXTENSIONS == SUPPORTED_AUDIO_EXTS
