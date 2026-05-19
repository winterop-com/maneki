"""Tests for HLS endpoint routing + session management (no real ffmpeg run)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.video.serve import create_app


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    return TestClient(create_app(library_root))


def test_hls_unknown_id_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/hls/index.m3u8")
    assert resp.status_code == 404


def test_hls_rejects_path_traversal(client: TestClient) -> None:
    # ".."-style filename in the slot - shouldn't reach the session lookup.
    resp = client.get("/api/videos/movie/hls/.hidden")
    assert resp.status_code == 400


def test_hls_503_when_ffmpeg_missing(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    import shutil

    monkeypatch.setattr(shutil, "which", lambda _: None)
    resp = client.get("/api/videos/movie/hls/index.m3u8")
    assert resp.status_code == 503
    assert "ffmpeg" in resp.json()["detail"]
