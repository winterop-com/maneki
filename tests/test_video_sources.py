"""MediaSource arg-building: local single-input vs remote split-stream."""

from __future__ import annotations

from pathlib import Path

from maneki.video.serve.sources import LocalSource, RemoteSource


def test_local_source_single_input_no_map() -> None:
    src = LocalSource(path=Path("/library/videos/movie.mkv"))
    assert src.seek_input_args(12.0) == ["-ss", "12.000000", "-i", "/library/videos/movie.mkv"]
    # Local files let ffmpeg auto-select streams — no explicit -map.
    assert src.map_args() == []
    assert src.display_name() == "movie.mkv"


def test_remote_source_two_inputs_each_seeked() -> None:
    src = RemoteSource(video_url="https://v.example/clip", audio_url="https://a.example/clip", name="Some Video")
    # Both inputs carry their own -ss so ffmpeg seeks each via the demuxer
    # (an HTTP range request), not by decoding from zero.
    assert src.seek_input_args(30.0) == [
        "-ss",
        "30.000000",
        "-i",
        "https://v.example/clip",
        "-ss",
        "30.000000",
        "-i",
        "https://a.example/clip",
    ]
    # Split streams must be mapped explicitly: video from input 0, audio from 1.
    assert src.map_args() == ["-map", "0:v:0", "-map", "1:a:0"]
    assert src.display_name() == "Some Video"


def test_remote_source_replays_headers_per_input() -> None:
    # googlevideo 403s without the resolved User-Agent; it must be replayed on
    # BOTH inputs (video + audio) via -user_agent, with other headers in -headers.
    src = RemoteSource(
        video_url="https://v",
        audio_url="https://a",
        name="x",
        headers={"User-Agent": "yt/1.0", "Accept": "*/*"},
    )
    args = src.seek_input_args(0.0)
    assert args.count("-user_agent") == 2
    assert args.count("yt/1.0") == 2
    # Non-UA headers ride in -headers as CRLF-joined lines.
    assert any("Accept: */*" in a for a in args)


def test_remote_source_assumes_sdr() -> None:
    # Remote sources skip the (slow, network) HDR probe and report SDR.
    src = RemoteSource(video_url="https://v", audio_url="https://a", name="x")
    assert src.is_hdr() is False
