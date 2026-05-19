"""Tests for subtitle sidecar discovery + WebVTT conversion + endpoint."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.video.serve import create_app
from mediakit.video.serve.subtitles import discover_sidecars, srt_to_vtt, to_webvtt

# -----------------------------------------------------------------------------
# discover_sidecars
# -----------------------------------------------------------------------------


def test_discover_no_subtitles(tmp_path: Path) -> None:
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    assert discover_sidecars(video) == []


def test_discover_undetermined_lang(tmp_path: Path) -> None:
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    (tmp_path / "movie.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nhello\n", encoding="utf-8")
    found = discover_sidecars(video)
    assert len(found) == 1
    assert found[0].language == "und"
    assert found[0].fmt == "srt"


def test_discover_with_lang_code(tmp_path: Path) -> None:
    video = tmp_path / "show.mp4"
    video.write_bytes(b"x")
    (tmp_path / "show.en.srt").write_text("...", encoding="utf-8")
    (tmp_path / "show.fr.srt").write_text("...", encoding="utf-8")
    found = discover_sidecars(video)
    langs = sorted(s.language for s in found)
    assert langs == ["en", "fr"]


def test_discover_strips_modifiers(tmp_path: Path) -> None:
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    (tmp_path / "movie.en.forced.srt").write_text("...", encoding="utf-8")
    found = discover_sidecars(video)
    assert len(found) == 1
    assert found[0].language == "en"


def test_discover_ignores_unrelated_subtitles(tmp_path: Path) -> None:
    video = tmp_path / "movie.mkv"
    video.write_bytes(b"x")
    (tmp_path / "other-thing.srt").write_text("...", encoding="utf-8")
    assert discover_sidecars(video) == []


# -----------------------------------------------------------------------------
# srt_to_vtt
# -----------------------------------------------------------------------------


def test_srt_to_vtt_adds_header() -> None:
    out = srt_to_vtt("1\n00:00:01,000 --> 00:00:02,000\nhello\n")
    assert out.startswith("WEBVTT\n\n")
    assert "00:00:01.000 --> 00:00:02.000" in out
    assert ",000" not in out


def test_to_webvtt_passes_through_vtt(tmp_path: Path) -> None:
    vtt = tmp_path / "sub.vtt"
    vtt.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n", encoding="utf-8")
    out = to_webvtt(vtt)
    assert out.startswith("WEBVTT")
    assert "00:00:01.000" in out


def test_to_webvtt_adds_header_to_headerless_vtt(tmp_path: Path) -> None:
    vtt = tmp_path / "sub.vtt"
    vtt.write_text("00:00:01.000 --> 00:00:02.000\nhi\n", encoding="utf-8")
    out = to_webvtt(vtt)
    assert out.startswith("WEBVTT\n\n")


# -----------------------------------------------------------------------------
# /api/videos/{id}/subtitles endpoints
# -----------------------------------------------------------------------------


@pytest.fixture
def library_with_subtitles(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    (videos / "movie.en.srt").write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:03,000 --> 00:00:04,000\nworld\n",
        encoding="utf-8",
    )
    (videos / "movie.fr.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nbonjour\n", encoding="utf-8")
    # A video without sidecars to confirm the empty-list shape works.
    (videos / "lonely.mp4").write_bytes(b"x")
    return tmp_path


@pytest.fixture
def client(library_with_subtitles: Path) -> TestClient:
    return TestClient(create_app(library_with_subtitles))


def test_videos_list_includes_subtitles(client: TestClient) -> None:
    videos = client.get("/api/videos").json()
    by_name = {v["name"]: v for v in videos}
    movie_subs = sorted(by_name["movie"]["subtitles"], key=lambda s: s["lang"])
    assert [s["lang"] for s in movie_subs] == ["en", "fr"]
    assert all(s["format"] == "srt" for s in movie_subs)
    assert by_name["lonely"]["subtitles"] == []


def test_list_subtitles_endpoint(client: TestClient) -> None:
    videos = client.get("/api/videos").json()
    movie_id = next(v["id"] for v in videos if v["name"] == "movie")
    resp = client.get(f"/api/videos/{movie_id}/subtitles")
    assert resp.status_code == 200
    data = resp.json()
    assert sorted(s["lang"] for s in data) == ["en", "fr"]
    assert all(s["url"].endswith(f"/{s['lang']}") for s in data)


def test_stream_subtitle_returns_webvtt(client: TestClient) -> None:
    videos = client.get("/api/videos").json()
    movie_id = next(v["id"] for v in videos if v["name"] == "movie")
    resp = client.get(f"/api/videos/{movie_id}/subtitles/en")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/vtt")
    body = resp.text
    assert body.startswith("WEBVTT")
    assert "00:00:01.000 --> 00:00:02.000" in body  # converted from SRT comma
    assert "hello" in body


def test_stream_subtitle_unknown_lang_is_404(client: TestClient) -> None:
    videos = client.get("/api/videos").json()
    movie_id = next(v["id"] for v in videos if v["name"] == "movie")
    resp = client.get(f"/api/videos/{movie_id}/subtitles/de")
    assert resp.status_code == 404


def test_stream_subtitle_unknown_video_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/subtitles/en")
    assert resp.status_code == 404
