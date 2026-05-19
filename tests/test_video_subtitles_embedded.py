"""Tests for embedded-subtitle probe + extract helpers.

The probe path is exercised against a synthetic ffprobe response by
patching `subprocess.run`. The extract path needs real ffmpeg, so we
only smoke-test the no-ffmpeg branch + cache lookup behaviour.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from mediakit.video.serve.subtitles import (
    EmbeddedSubtitle,
    SubtitleCache,
    probe_embedded_subtitles,
    shift_vtt_timestamps,
)


@pytest.fixture
def video_file(tmp_path: Path) -> Path:
    p = tmp_path / "movie.mkv"
    p.write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    return p


def _fake_run(stdout_json: dict[str, Any], returncode: int = 0) -> Any:
    """Build a subprocess.run patch returning the given ffprobe JSON."""

    def _run(*_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=_args[0] if _args else [],
            returncode=returncode,
            stdout=json.dumps(stdout_json),
            stderr="",
        )

    return _run


def test_probe_returns_text_streams(monkeypatch: pytest.MonkeyPatch, video_file: Path) -> None:
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.shutil.which",
        lambda _: "/usr/bin/ffprobe",
    )
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.subprocess.run",
        _fake_run(
            {
                "streams": [
                    {
                        "index": 2,
                        "codec_name": "subrip",
                        "tags": {"language": "eng"},
                        "disposition": {"default": 1, "forced": 0},
                    },
                    {
                        "index": 3,
                        "codec_name": "ass",
                        "tags": {"language": "jpn", "title": "Japanese (full)"},
                        "disposition": {"default": 0, "forced": 0},
                    },
                ]
            }
        ),
    )
    result = probe_embedded_subtitles(video_file)
    assert len(result) == 2
    assert result[0] == EmbeddedSubtitle(
        stream_index=2,
        language="eng",
        codec_name="subrip",
        title=None,
        default=True,
        forced=False,
    )
    assert result[1].title == "Japanese (full)"


def test_probe_filters_image_based_codecs(
    monkeypatch: pytest.MonkeyPatch, video_file: Path
) -> None:
    """PGS, DVD VobSub etc. need OCR - we don't surface them."""
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.shutil.which",
        lambda _: "/usr/bin/ffprobe",
    )
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.subprocess.run",
        _fake_run(
            {
                "streams": [
                    {
                        "index": 2,
                        "codec_name": "hdmv_pgs_subtitle",
                        "tags": {"language": "eng"},
                    },
                    {
                        "index": 3,
                        "codec_name": "dvd_subtitle",
                        "tags": {"language": "fre"},
                    },
                    {
                        "index": 4,
                        "codec_name": "subrip",
                        "tags": {"language": "eng"},
                    },
                ]
            }
        ),
    )
    result = probe_embedded_subtitles(video_file)
    # Only the subrip survives.
    assert [s.codec_name for s in result] == ["subrip"]


def test_probe_without_ffprobe_returns_empty(
    monkeypatch: pytest.MonkeyPatch, video_file: Path
) -> None:
    monkeypatch.setattr("mediakit.video.serve.subtitles.shutil.which", lambda _: None)
    assert probe_embedded_subtitles(video_file) == []


def test_probe_handles_missing_tags(
    monkeypatch: pytest.MonkeyPatch, video_file: Path
) -> None:
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.shutil.which",
        lambda _: "/usr/bin/ffprobe",
    )
    monkeypatch.setattr(
        "mediakit.video.serve.subtitles.subprocess.run",
        _fake_run({"streams": [{"index": 2, "codec_name": "subrip"}]}),
    )
    result = probe_embedded_subtitles(video_file)
    assert result[0].language == "und"
    assert result[0].title is None


def test_probe_missing_file_returns_empty(tmp_path: Path) -> None:
    assert probe_embedded_subtitles(tmp_path / "does-not-exist.mkv") == []


def test_subtitle_cache_path_layout(tmp_path: Path) -> None:
    cache = SubtitleCache(cache_dir=tmp_path)
    p = cache.path_for("show-s01e01", 2)
    assert p == tmp_path / "show-s01e01" / "embed-2.vtt"


def test_shift_vtt_timestamps_subtracts_offset() -> None:
    src = (
        "WEBVTT\n\n"
        "00:00:11.929 --> 00:00:14.523\n"
        "He's a very good listener.\n\n"
        "00:01:00.500 --> 00:01:02.000\n"
        "Hello world.\n"
    )
    shifted = shift_vtt_timestamps(src, -0.083)
    assert "00:00:11.846 --> 00:00:14.440" in shifted
    assert "00:01:00.417 --> 00:01:01.917" in shifted


def test_shift_vtt_timestamps_clamps_at_zero() -> None:
    """Negative results clamp to 00:00:00.000 - no negative timestamps."""
    src = (
        "WEBVTT\n\n"
        "00:00:00.050 --> 00:00:02.000\n"
        "Early cue.\n"
    )
    shifted = shift_vtt_timestamps(src, -0.100)
    assert "00:00:00.000 --> 00:00:01.900" in shifted


def test_shift_vtt_timestamps_handles_rounding_overflow() -> None:
    """ms=999 + small offset shouldn't produce ms=1000."""
    src = "WEBVTT\n\n00:00:01.999 --> 00:00:03.000\nhello\n"
    shifted = shift_vtt_timestamps(src, 0.002)
    # 1.999 + 0.002 = 2.001 -> 00:00:02.001
    assert "00:00:02.001" in shifted


def test_shift_vtt_timestamps_no_op_for_zero_offset() -> None:
    src = "WEBVTT\n\n00:00:11.929 --> 00:00:14.523\nhi\n"
    assert shift_vtt_timestamps(src, 0.0) == src
